use annotator_core::{analysis::scheduler::Scheduler, error::ErrorCode};
use std::{sync::mpsc, time::Duration};
#[test]
fn more_than_256_sequentially_disposed_views_keep_accepting_work() {
    let scheduler = Scheduler::new(1, 32);
    for _ in 0..300 {
        let view = scheduler.register_view().unwrap();
        scheduler
            .submit(&view, 1, true, |_| Ok(vec![1]))
            .unwrap()
            .recv()
            .unwrap()
            .unwrap();
        scheduler.cancel_generation(&view, 1).unwrap();
        scheduler.retire_view(&view).unwrap();
        assert_eq!(scheduler.live_views(), 0);
        assert_eq!(
            scheduler
                .submit(&view, 99, true, |_| panic!("retired owner ran"))
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            scheduler.cancel_generation(&view, 99).unwrap_err().code,
            ErrorCode::Cancelled
        );
    }
}
#[test]
fn live_leases_are_bounded_and_unknown_cancel_never_allocates() {
    let scheduler = Scheduler::new(1, 32);
    for i in 0..300 {
        assert!(scheduler
            .cancel_generation(&format!("unknown-{i}"), 1)
            .is_err());
    }
    assert_eq!(scheduler.live_views(), 0);
    let leases: Vec<_> = (0..256)
        .map(|_| scheduler.register_view().unwrap())
        .collect();
    assert_eq!(
        scheduler.register_view().unwrap_err().code,
        ErrorCode::ResourceLimit
    );
    for lease in leases {
        scheduler.retire_view(&lease).unwrap();
    }
    assert_eq!(scheduler.live_views(), 0);
    assert!(scheduler.register_view().is_ok());
}
#[test]
fn retirement_and_reset_cancel_late_results_without_affecting_other_views() {
    let scheduler = Scheduler::new(1, 32);
    let a = scheduler.register_view().unwrap();
    let b = scheduler.register_view().unwrap();
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let running = scheduler
        .submit(&a, 1, true, move |_| {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok(vec![1])
        })
        .unwrap();
    started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let queued = scheduler
        .submit(&a, 1, true, |_| panic!("retired queued work ran"))
        .unwrap();
    let other = scheduler.submit(&b, 1, true, |_| Ok(vec![2])).unwrap();
    scheduler.retire_view(&a).unwrap();
    release_tx.send(()).unwrap();
    for result in [running, queued] {
        assert_eq!(
            result
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
    }
    assert_eq!(
        other.recv_timeout(Duration::from_secs(3)).unwrap().unwrap(),
        vec![2]
    );
    scheduler.cancel_generation(&b, 4).unwrap();
    assert!(scheduler.submit(&b, 3, true, |_| Ok(vec![])).is_err());
    assert!(scheduler
        .submit(&b, 5, true, |_| Ok(vec![]))
        .unwrap()
        .recv()
        .unwrap()
        .is_ok());
    scheduler.reset();
    let reopened = scheduler.register_view().unwrap();
    assert_ne!(reopened, b);
    assert!(scheduler
        .submit(&b, 999, true, |_| panic!("old runtime ran"))
        .is_err());
    assert!(scheduler.cancel_generation(&b, 999).is_err());
    assert!(scheduler.retire_view(&b).is_err());
    assert_eq!(scheduler.live_views(), 1);
    assert!(scheduler
        .submit(&reopened, 1, true, |_| Ok(vec![]))
        .unwrap()
        .recv()
        .unwrap()
        .is_ok());
}
