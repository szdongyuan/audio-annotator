use crate::error::{AppError, ErrorCode, Result};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
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
}
struct State {
    queue: VecDeque<Job>,
    scopes: HashMap<String, Scope>,
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
            },
        );
        Ok(view)
    }
    pub fn retire_view(&self, view: &str) -> Result<()> {
        let mut state = self.shared.state.lock().map_err(|_| cancelled())?;
        let scope = state.scopes.remove(view).ok_or_else(cancelled)?;
        scope.cancel.store(true, Ordering::Release);
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
                scope.cancel.store(true, Ordering::Release);
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
            };
        }
        let cancel = scope.cancel.clone();
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
                scope.cancel.store(true, Ordering::Release);
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
            scope.cancel.store(true, Ordering::Release);
        }
        Self::purge(&mut state);
        state.scopes.clear();
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
