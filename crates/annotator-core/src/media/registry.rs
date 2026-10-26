use super::decode::DecodedMedia;
use crate::{
    error::{AppError, ErrorCode, Result},
    model::MediaDescriptor,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{collections::HashMap, sync::Arc};

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
}
impl MediaRegistry {
    pub fn insert(&mut self, media: Arc<DecodedMedia>) {
        self.entries.insert(media.descriptor.id.clone(), media);
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
    pub fn clear(&mut self) {
        self.entries.clear();
    }
}
