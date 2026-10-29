use crate::error::{AppError, ErrorCode, Result};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex, Weak,
    },
    thread,
};
type Work = Box<dyn FnOnce(&AtomicBool) -> Result<Vec<u8>> + Send + 'static>;
struct Job {
    visible: bool,
    cancel: Arc<AtomicBool>,
    work: Work,
    result: mpsc::Sender<Result<Vec<u8>>>,
}
struct Scope {
    generation: u64,
    cancel: Arc<AtomicBool>,
    jobs: Vec<Weak<AtomicBool>>,
}
impl Scope {
    fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
        for job in &self.jobs {
            if let Some(cancel) = job.upgrade() {
                cancel.store(true, Ordering::Release);
            }
        }
    }
}
struct State {
    queue: VecDeque<Job>,
    scopes: HashMap<String, Scope>,
    media_jobs: HashMap<String, Vec<Weak<AtomicBool>>>,
    next_view: u64,
    active: usize,
    shutdown: bool,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    capacity: usize,
}
pub struct Scheduler {
    shared: Arc<Shared>,
    workers: Vec<thread::JoinHandle<()>>,
}
fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled, "分析请求已取消或过期")
}
impl Default for Scheduler {
    fn default() -> Self {
        Self::new(2, 32)
    }
}
impl Scheduler {
    pub fn new(workers: usize, capacity: usize) -> Self {
        assert!((1..=2).contains(&workers) && capacity <= 32);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                scopes: HashMap::new(),
                media_jobs: HashMap::new(),
                next_view: 0,
                active: 0,
                shutdown: false,
            }),
            wake: Condvar::new(),
            capacity,
        });
        let workers = (0..workers)
            .map(|_| {
                let shared = shared.clone();
                thread::spawn(move || loop {
                    let job = {
                        let mut state = shared.state.lock().unwrap();
                        while state.queue.is_empty() && !state.shutdown {
                            state = shared.wake.wait(state).unwrap();
                        }
                        if state.shutdown {
                            return;
                        }
                        state.active += 1;
                        state.queue.pop_front().unwrap()
                    };
                    let result = if job.cancel.load(Ordering::Acquire) {
                        // A captured runtime must be released before idle is published.
                        drop(job.work);
                        Err(cancelled())
                    } else {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            (job.work)(&job.cancel)
                        }))
                        .unwrap_or_else(|_| {
                            Err(AppError::new(ErrorCode::AnalysisFailed, "分析工作线程失败"))
                        })
                    };
                    let mut state = shared.state.lock().unwrap();
                    state.active -= 1;
                    // Serialized with generation cancellation, including results that arrive late.
                    let result = if job.cancel.load(Ordering::Acquire) {
                        Err(cancelled())
                    } else {
                        result
                    };
                    let _ = job.result.send(result);
                })
            })
            .collect();
        Self { shared, workers }
    }
    /// Only registered leases may submit work. IDs are never reused, even after
    /// reset, so late IPC cannot recreate a retired scope without tombstones.
    pub fn register_view(&self) -> Result<String> {
        let mut state = self.shared.state.lock().map_err(|_| cancelled())?;
        if state.scopes.len() >= 256 {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "同时活动的分析视图过多",
            ));
        }
        state.next_view = state.next_view.checked_add(1).ok_or_else(cancelled)?;
        let view = format!("view-{}", state.next_view);
        state.scopes.insert(
            view.clone(),
            Scope {
                generation: 0,
                cancel: Arc::new(AtomicBool::new(false)),
                jobs: vec![],
            },
        );
        Ok(view)
    }
    pub fn retire_view(&self, view: &str) -> Result<()> {
        let mut state = self.shared.state.lock().map_err(|_| cancelled())?;
        let scope = state.scopes.remove(view).ok_or_else(cancelled)?;
        scope.cancel();
        Self::purge(&mut state);
        Ok(())
    }
    pub fn live_views(&self) -> usize {
        self.shared.state.lock().unwrap().scopes.len()
    }
    pub fn submit(
        &self,
        view: &str,
        generation: u64,
        visible: bool,
        work: impl FnOnce(&AtomicBool) -> Result<Vec<u8>> + Send + 'static,
    ) -> Result<mpsc::Receiver<Result<Vec<u8>>>> {
        self.submit_bound(view, generation, visible, None, work)
    }
    pub fn submit_media(
        &self,
        view: &str,
        generation: u64,
        visible: bool,
        media_id: &str,
        work: impl FnOnce(&AtomicBool) -> Result<Vec<u8>> + Send + 'static,
    ) -> Result<mpsc::Receiver<Result<Vec<u8>>>> {
        self.submit_bound(view, generation, visible, Some(media_id), work)
    }
    fn submit_bound(
        &self,
        view: &str,
        generation: u64,
        visible: bool,
        media_id: Option<&str>,
        work: impl FnOnce(&AtomicBool) -> Result<Vec<u8>> + Send + 'static,
    ) -> Result<mpsc::Receiver<Result<Vec<u8>>>> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| AppError::invalid("分析调度器不可用"))?;
        if let Some(scope) = state.scopes.get(view) {
            if generation < scope.generation
                || generation == scope.generation && scope.cancel.load(Ordering::Acquire)
            {
                return Err(cancelled());
            }
            if generation > scope.generation {
                scope.cancel();
            }
        } else {
            return Err(cancelled());
        }
        Self::purge(&mut state);
        if state.queue.len() >= self.shared.capacity {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "分析队列已满，请稍后重试",
            ));
        }
        let scope = state.scopes.get_mut(view).unwrap();
        if generation > scope.generation {
            *scope = Scope {
                generation,
                cancel: Arc::new(AtomicBool::new(false)),
                jobs: vec![],
            };
        }
        scope.jobs.retain(|job| job.strong_count() > 0);
        let cancel = if media_id.is_some() {
            Arc::new(AtomicBool::new(false))
        } else {
            scope.cancel.clone()
        };
        if media_id.is_some() {
            scope.jobs.push(Arc::downgrade(&cancel));
        }
        if let Some(media_id) = media_id {
            state.media_jobs.retain(|_, jobs| {
                jobs.retain(|job| job.strong_count() > 0);
                !jobs.is_empty()
            });
            state
                .media_jobs
                .entry(media_id.into())
                .or_default()
                .push(Arc::downgrade(&cancel));
        }
        let (tx, rx) = mpsc::channel();
        let job = Job {
            visible,
            cancel,
            work: Box::new(work),
            result: tx,
        };
        if visible {
            let index = state
                .queue
                .iter()
                .position(|j| !j.visible)
                .unwrap_or(state.queue.len());
            state.queue.insert(index, job);
        } else {
            state.queue.push_back(job);
        }
        self.shared.wake.notify_one();
        Ok(rx)
    }
    fn purge(state: &mut State) {
        state.queue.retain(|job| {
            if job.cancel.load(Ordering::Acquire) {
                let _ = job.result.send(Err(cancelled()));
                false
            } else {
                true
            }
        });
    }
    pub fn cancel_generation(&self, view: &str, generation: u64) -> Result<()> {
        let mut state = self.shared.state.lock().unwrap();
        if let Some(scope) = state.scopes.get_mut(view) {
            if generation >= scope.generation {
                scope.cancel();
                scope.generation = generation;
            }
        } else {
            return Err(cancelled());
        }
        Self::purge(&mut state);
        Ok(())
    }
    pub fn reset(&self) {
        let mut state = self.shared.state.lock().unwrap();
        for scope in state.scopes.values() {
            scope.cancel();
        }
        Self::purge(&mut state);
        state.scopes.clear();
        state.media_jobs.clear();
    }
    pub fn retire_media(&self, ids: &[String]) {
        let mut state = self.shared.state.lock().unwrap();
        for id in ids {
            if let Some(jobs) = state.media_jobs.remove(id) {
                for job in jobs {
                    if let Some(cancel) = job.upgrade() {
                        cancel.store(true, Ordering::Release);
                    }
                }
            }
        }
        Self::purge(&mut state);
    }
    pub fn stats(&self) -> (usize, usize) {
        let state = self.shared.state.lock().unwrap();
        (state.active, state.queue.len())
    }
}
impl Drop for Scheduler {
    fn drop(&mut self) {
        self.reset();
        {
            let mut state = self.shared.state.lock().unwrap();
            state.shutdown = true;
        }
        self.shared.wake.notify_all();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}
#[cfg(test)]
mod lifetime_tests {
    use super::*;
    struct ObserveDrop {
        shared: Arc<Shared>,
        observed: mpsc::Sender<usize>,
    }
    impl Drop for ObserveDrop {
        fn drop(&mut self) {
            let active = self.shared.state.lock().unwrap().active;
            self.observed.send(active).unwrap();
        }
    }
    #[test]
    fn cancelled_uncalled_work_is_dropped_before_the_worker_reports_idle() {
        let scheduler = Scheduler::new(1, 1);
        let (observed, receive_drop) = mpsc::channel();
        let guard = ObserveDrop {
            shared: scheduler.shared.clone(),
            observed,
        };
        let (result, receive) = mpsc::channel();
        scheduler.shared.state.lock().unwrap().queue.push_back(Job {
            visible: true,
            cancel: Arc::new(AtomicBool::new(true)),
            work: Box::new(move |_| {
                drop(guard);
                Ok(vec![])
            }),
            result,
        });
        scheduler.shared.wake.notify_one();
        assert!(receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .is_err());
        assert_eq!(
            receive_drop
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            1
        );
    }
}

#[cfg(test)]
mod retirement_tests {
    use super::*;
    #[test]
    fn media_retirement_cancels_active_and_queued_a_but_preserves_b_and_view_lease() {
        let scheduler = Scheduler::new(1, 32);
        let view = scheduler.register_view().unwrap();
        let (entered, arrival) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let a = scheduler
            .submit_media(&view, 1, true, "a", move |_| {
                entered.send(()).unwrap();
                wait.recv().unwrap();
                Ok(vec![1])
            })
            .unwrap();
        arrival.recv().unwrap();
        let queued_a = scheduler
            .submit_media(&view, 1, true, "a", |_| Ok(vec![2]))
            .unwrap();
        let b = scheduler
            .submit_media(&view, 1, true, "b", |_| Ok(vec![3]))
            .unwrap();
        scheduler.retire_media(&["a".into()]);
        assert_eq!(
            queued_a.recv().unwrap().unwrap_err().code,
            ErrorCode::Cancelled
        );
        release.send(()).unwrap();
        assert_eq!(a.recv().unwrap().unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(b.recv().unwrap().unwrap(), vec![3]);
        assert_eq!(
            scheduler
                .submit_media(&view, 1, true, "b", |_| Ok(vec![4]))
                .unwrap()
                .recv()
                .unwrap()
                .unwrap(),
            vec![4]
        );
        assert_eq!(scheduler.live_views(), 1);
    }
}
