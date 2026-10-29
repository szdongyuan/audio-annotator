//! A prepared batch has one organization-head commit and one verified catalog scan.
use super::*;

impl CollaborationRepository {
    pub fn append_media_batch_interleaved(
        &self,
        session: &AuthorSession,
        items: &[&PreparedCatalogMedia],
        cancel: &AtomicBool,
        fault: Option<atomic::PublishFault>,
        before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<Self> {
        self.session_authority(session)?;
        limit(!items.is_empty() && items.len() <= 256)?;
        let mut ids = std::collections::HashSet::new();
        for item in items {
            require(
                item.root == self.root && item.project_id == self.manifest.project_id,
                "Prepared media belongs to another project",
            )?;
            require(ids.insert(&item.media.id), "Duplicate batch media")?;
        }
        // Acknowledged retry can succeed after the original source disappears.
        let head = organization::read(&self.metadata_root, &self.manifest.project_id)?;
        let committed: std::collections::HashSet<_> =
            head.media.iter().map(|m| &m.media_id).collect();
        if items.iter().all(|m| committed.contains(&m.media.id)) {
            let current = self.reload_catalog()?;
            for item in items {
                require(
                    current.manifest.media.iter().any(|m| m == &item.media),
                    "Committed media differs from retry",
                )?;
            }
            return Ok(current);
        }
        for item in items {
            if committed.contains(&item.media.id) {
                continue;
            }
            check_cancel(cancel)?;
            atomic::safe_existing(&item.source)?;
            item.stamp.verify(&item.source)?;
            let placement = item.owned_placement()?;
            require(
                fs::metadata(&placement).map_err(atomic::io)?.len() == item.media.byte_length
                    && fingerprint(&placement, cancel, |_| {})? == item.media.sha256,
                "Staged media changed",
            )
            .map_err(|e| item.retained_error(e))?;
        }
        let _lock = self.commit_guard()?;
        self.session_authority(session)?;
        let mut current = self.reload_catalog()?;
        current.reject_retired_media(items.iter().map(|m| m.media.id.as_str()))?;
        let mut head = current.organization.clone();
        let mut records = Vec::new();
        let mut byte_length = current.catalog_revision.as_ref().unwrap().byte_length;
        for item in items {
            if let Some(existing) = current
                .manifest
                .media
                .iter()
                .find(|m| m.id == item.media.id)
            {
                require(
                    existing == &item.media,
                    "Committed media differs from retry",
                )?;
                continue;
            }
            check_cancel(cancel)?;
            item.stamp.verify(&item.source)?;
            head = head.add_media(&item.media.id, &item.placement)?;
            let record = serde_json::to_vec(&CatalogRecord::new(
                &self.manifest.project_id,
                item.media.clone(),
            ))
            .map_err(|_| AppError::invalid("Cannot encode catalog record"))?;
            limit(record.len() <= MAX_RECORD_BYTES)?;
            byte_length += record.len();
            limit(byte_length <= MAX_LAYER_BYTES)?;
            records.push((*item, record));
        }
        limit(current.manifest.media.len() + records.len() <= MAX_MEDIA)?;
        if records.is_empty() {
            return Ok(current);
        }
        let head_bytes = organization::encode(&head)?;
        for (index, entry) in fs::read_dir(self.metadata_root.join("catalog"))
            .map_err(atomic::io)?
            .enumerate()
        {
            entry.map_err(atomic::io)?;
            limit(index < MAX_CATALOG_ENTRIES - records.len())?;
        }
        // Failed publication retains only these sealed identities for an explicit retry.
        // Existing immutable records are never replaced and the head stays unchanged.
        for (item, record) in &records {
            check_cancel(cancel)?;
            let target = self.root.join(&item.media.source_ref);
            atomic::safe_existing(target.parent().unwrap())?;
            if item.owned_placement()? == item.staged {
                atomic::no_replace(&item.staged, &target).map_err(atomic::io)?;
            }
            atomic::verify_lock_path(&target, &item.owned_file)?;
            if fault == Some(atomic::PublishFault::BeforeRecord) {
                return Err(atomic::io(std::io::Error::other("Injected before record")));
            }
            let path = self
                .metadata_root
                .join("catalog")
                .join(format!("{}.json", item.media.id));
            if path.try_exists().map_err(atomic::io)? {
                require(
                    atomic::read(&path, MAX_RECORD_BYTES)? == *record,
                    "Uncommitted record differs",
                )?;
            } else {
                atomic::publish_new(&path, record, None, Some(cancel))?;
            }
            current.manifest.media.push(item.media.clone());
            current
                .catalog_record_hashes
                .push((item.media.id.clone(), hash(record)));
        }
        if fault == Some(atomic::PublishFault::AfterRecord) {
            return Err(atomic::io(std::io::Error::other("Injected after record")));
        }
        before_commit()?;
        current.manifest.media.sort_by(|a, b| a.id.cmp(&b.id));
        current.catalog_record_hashes.sort_by(|a, b| a.0.cmp(&b.0));
        current.manifest.validate()?;
        let revision = current.catalog_revision.as_mut().unwrap();
        revision.media_count = current.manifest.media.len();
        revision.byte_length = byte_length;
        revision.digest = record_digest(&current.catalog_record_hashes)?;
        atomic::replace_metadata_controlled(
            &self.metadata_root.join("organization.json"),
            &head_bytes,
            fault,
            Some(cancel),
        )?;
        current.organization = head;
        Ok(current)
    }
}
