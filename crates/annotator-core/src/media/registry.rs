use super::decode::DecodedMedia;
use crate::{
    error::{AppError, ErrorCode, Result},
    model::MediaDescriptor,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

pub fn same_identity(a: &MediaDescriptor, b: &MediaDescriptor) -> bool {
    a.sha256 == b.sha256
        && a.byte_length == b.byte_length
        && a.sample_rate == b.sample_rate
        && a.frame_count == b.frame_count
        && a.channel_count == b.channel_count
        && a.channel_layout == b.channel_layout
}

/// Short-held task authority. A generation identifies one native project runtime,
/// including Save As replacements which deliberately keep the same project ID.
#[derive(Default)]
pub struct MediaTasks {
    generation: u64,
    running: HashMap<String, Arc<AtomicBool>>,
    pending: HashMap<String, (String, Arc<DecodedMedia>)>,
    pub registry: MediaRegistry,
}
impl MediaTasks {
    pub fn has_pending_work(&self) -> bool {
        !self.running.is_empty() || !self.pending.is_empty()
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn publish_rehydrated(
        &mut self,
        generation: u64,
        media: DecodedMedia,
    ) -> Result<Arc<DecodedMedia>> {
        if generation != self.generation {
            return Err(AppError::new(ErrorCode::Cancelled, "项目运行态已替换"));
        }
        let media = Arc::new(media);
        self.registry.insert(media.clone());
        Ok(media)
    }
    pub fn begin(&mut self, task_id: String) -> Result<(u64, Arc<AtomicBool>)> {
        if !self.running.is_empty() || self.pending.len() >= 256 {
            return Err(AppError::new(
                ErrorCode::ResourceLimit,
                "请等待当前导入完成",
            ));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.running.insert(task_id, cancel.clone());
        Ok((self.generation, cancel))
    }
    pub fn cancel(&self, task_id: &str) {
        if let Some(cancel) = self.running.get(task_id) {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    pub fn finish(&mut self, task_id: &str) {
        self.running.remove(task_id);
    }
    pub fn reset(&mut self) {
        for cancel in self.running.values() {
            cancel.store(true, Ordering::Relaxed);
        }
        self.running.clear();
        self.pending.clear();
        self.registry.clear();
        self.generation += 1;
    }
    pub fn prepare_for_task(
        &mut self,
        generation: u64,
        task_id: &str,
        media: DecodedMedia,
    ) -> Result<MediaDescriptor> {
        if generation != self.generation {
            return Err(AppError::new(
                ErrorCode::Cancelled,
                "项目已关闭或被另存替换",
            ));
        }
        let cancel = self
            .running
            .get(task_id)
            .ok_or_else(|| AppError::new(ErrorCode::Cancelled, "导入任务已结束"))?;
        super::identity::check_cancel(cancel)?;
        let descriptor = media.descriptor.clone();
        self.pending
            .insert(descriptor.id.clone(), (task_id.into(), Arc::new(media)));
        Ok(descriptor)
    }
    pub fn prepared(&self, descriptor: &MediaDescriptor) -> Result<Arc<DecodedMedia>> {
        let media = self.prepared_unverified(descriptor)?;
        media.verify_source()?;
        Ok(media)
    }
    /// Native captures under authority, verifies source outside it, then checks this binding again.
    pub fn prepared_unverified(&self, descriptor: &MediaDescriptor) -> Result<Arc<DecodedMedia>> {
        let (_, media) = self
            .pending
            .get(&descriptor.id)
            .ok_or_else(|| AppError::new(ErrorCode::Cancelled, "导入结果已过期，请重试"))?;
        if &media.descriptor != descriptor {
            return Err(AppError::new(
                ErrorCode::IdentityMismatch,
                "导入描述与已校验音频不一致",
            ));
        }
        Ok(media.clone())
    }
    pub fn commit(&mut self, media: Arc<DecodedMedia>) {
        self.pending.remove(&media.descriptor.id);
        self.registry.insert(media);
    }
    pub fn release_for_task(&mut self, task_id: &str, media_id: &str) {
        if self
            .pending
            .get(media_id)
            .is_some_and(|(owner, _)| owner == task_id)
        {
            self.pending.remove(media_id);
        }
    }
}
/// Runtime resources are independent of undoable document contents. Every consumer must
/// obtain a checked entry before analysis/playback; a changed source cannot use old PCM.
#[derive(Default)]
pub struct MediaRegistry {
    entries: HashMap<String, Arc<DecodedMedia>>,
    order: VecDeque<String>,
    verified: HashMap<String, (MediaDescriptor, super::identity::SourceStamp)>,
    bytes: u64,
}
impl MediaRegistry {
    pub fn insert(&mut self, media: Arc<DecodedMedia>) {
        let id = media.descriptor.id.clone();
        self.verified
            .insert(id.clone(), (media.descriptor.clone(), media.stamp.clone()));
        if let Some(previous) = self.entries.remove(&id) {
            self.bytes -= pcm_bytes(&previous);
        }
        self.order.retain(|old| old != &id);
        self.bytes += pcm_bytes(&media);
        self.entries.insert(id.clone(), media);
        self.order.push_back(id);
        // Keep only a bounded decoded working set. Active analysis/playback owns
        // its own Arc, so eviction cannot remove PCM still being consumed.
        while self.entries.len() > 64 || self.bytes > 256 * 1024 * 1024 && self.entries.len() > 1 {
            let oldest = self.order.pop_front().unwrap();
            if let Some(previous) = self.entries.remove(&oldest) {
                self.bytes -= pcm_bytes(&previous);
            }
        }
    }
    pub fn get_checked(&self, descriptor: &MediaDescriptor) -> Result<Arc<DecodedMedia>> {
        let entry = self.get_unverified(descriptor)?;
        entry.verify_source()?;
        Ok(entry)
    }
    /// Clone under the short registry lock; callers MUST verify_source after releasing it.
    pub fn get_unverified(&self, descriptor: &MediaDescriptor) -> Result<Arc<DecodedMedia>> {
        let entry = self
            .entries
            .get(&descriptor.id)
            .ok_or_else(|| AppError::new(ErrorCode::MissingMedia, "媒体尚未校验，请重新关联"))?;
        if !same_identity(&entry.descriptor, descriptor)
            || entry.descriptor.source_ref != descriptor.source_ref
        {
            return Err(AppError::new(
                ErrorCode::IdentityMismatch,
                "媒体绑定已变化，请重新校验",
            ));
        }
        Ok(entry.clone())
    }
    pub fn verified_stamp(
        &self,
        descriptor: &MediaDescriptor,
    ) -> Option<super::identity::SourceStamp> {
        self.verified
            .get(&descriptor.id)
            .filter(|(old, _)| {
                same_identity(old, descriptor) && old.source_ref == descriptor.source_ref
            })
            .map(|(_, stamp)| stamp.clone())
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.verified.clear();
        self.bytes = 0;
    }
}
fn pcm_bytes(media: &DecodedMedia) -> u64 {
    media
        .pcm
        .frame_count()
        .saturating_mul(media.pcm.channel_count() as u64)
        .saturating_mul(4)
}

#[cfg(test)]
mod bounded_tests {
    use super::*;
    #[test]
    fn eviction_keeps_verified_status_and_active_pcm_then_rehydrates_on_demand() {
        let root = std::env::temp_dir().join(format!("bounded-pcm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let cancel = AtomicBool::new(false);
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/audio/mono16.wav");
        let pinned =
            Arc::new(super::super::decode::decode(&source, &root, &cancel, |_, _| {}).unwrap());
        let descriptor = pinned.descriptor.clone();
        let first_path = pinned.pcm.path().to_path_buf();
        let mut registry = MediaRegistry::default();
        registry.insert(pinned.clone());
        for _ in 0..64 {
            registry.insert(Arc::new(
                super::super::decode::decode(&source, &root, &cancel, |_, _| {}).unwrap(),
            ));
        }
        assert_eq!(registry.entries.len(), 64);
        assert!(registry.get_unverified(&descriptor).is_err());
        assert!(registry.verified_stamp(&descriptor).is_some());
        assert!(first_path.exists());
        drop(pinned);
        assert!(!first_path.exists());
        let rehydrated = Arc::new(
            super::super::decode::rehydrate(
                &descriptor,
                std::path::Path::new("."),
                &root,
                &cancel,
                |_, _| {},
            )
            .unwrap(),
        );
        registry.insert(rehydrated);
        assert!(registry.get_checked(&descriptor).is_ok());
        registry.clear();
        assert!(registry.verified_stamp(&descriptor).is_none());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir(root).unwrap();
    }
}
