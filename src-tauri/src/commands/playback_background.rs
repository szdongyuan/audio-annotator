use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

type Job = Box<dyn FnMut() -> bool + Send>;

/// One running job and one replaceable pending job. Slow OS I/O never spawns
/// unbounded threads and cannot queue checks for every obsolete seek/source.
pub(super) struct PeriodicWorker {
    pending: Arc<Mutex<Option<Job>>>,
    wake: mpsc::SyncSender<()>,
}
impl PeriodicWorker {
    pub(super) fn new(name: &str, period: Duration) -> Self {
        let (wake, receive) = mpsc::sync_channel(1);
        let pending = Arc::new(Mutex::new(None::<Job>));
        let worker_pending = pending.clone();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let mut current: Option<Job> = None;
                loop {
                    let event = if current.is_some() {
                        receive.recv_timeout(period)
                    } else {
                        receive
                            .recv()
                            .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                    };
                    match event {
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Ok(()) => {
                            if let Some(next) =
                                worker_pending.lock().ok().and_then(|mut slot| slot.take())
                            {
                                current = Some(next);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    if current.as_mut().is_some_and(|job| !job()) {
                        current = None;
                    }
                }
            })
            .expect("playback background worker");
        Self { pending, wake }
    }
    pub(super) fn submit(&self, job: impl FnMut() -> bool + Send + 'static) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        *pending = Some(Box::new(job));
        drop(pending);
        if matches!(
            self.wake.try_send(()),
            Err(mpsc::TrySendError::Disconnected(_))
        ) {
            if let Ok(mut pending) = self.pending.lock() {
                *pending = None;
            }
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_io_keeps_only_latest_pending_job_and_does_not_block_another_worker() {
        let slow = PeriodicWorker::new("slow-source-test", Duration::from_millis(5));
        let progress = PeriodicWorker::new("progress-test", Duration::from_millis(5));
        let (entered, receive_entered) = mpsc::channel();
        let (release, receive_release) = mpsc::channel();
        let mut receive_release = Some(receive_release);
        slow.submit(move || {
            entered.send(()).unwrap();
            receive_release.take().unwrap().recv().unwrap();
            false
        });
        receive_entered
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let (seen, receive_seen) = mpsc::channel();
        for id in 0..100 {
            let seen = seen.clone();
            slow.submit(move || {
                seen.send(id).unwrap();
                false
            });
        }
        let (ticks, receive_ticks) = mpsc::channel();
        progress.submit(move || ticks.send(()).is_ok());
        // Progress can publish repeatedly while the source verification is blocked.
        for _ in 0..8 {
            receive_ticks.recv_timeout(Duration::from_secs(2)).unwrap();
        }
        assert!(receive_seen.try_recv().is_err());
        release.send(()).unwrap();
        assert_eq!(
            receive_seen.recv_timeout(Duration::from_secs(2)).unwrap(),
            99
        );
        assert!(receive_seen
            .recv_timeout(Duration::from_millis(30))
            .is_err());
    }
}
