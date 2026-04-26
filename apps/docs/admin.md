# Admin & operations

## User management

The first visit to the app triggers the **First-run admin wizard**, which creates the bootstrap admin account. After that:

- Public self-registration is disabled.
- Admins can create new accounts at `/auth/register` (admin-only route).
- User roles: **admin** (full access) and **annotator** (project-scoped access).

## Backups

A backup script is provided at `scripts/backup.sh`. It dumps Postgres and snapshots the MinIO bucket to a local archive directory.

Recommended cron (daily at 03:00):

```cron
0 3 * * * /path/to/repo/scripts/backup.sh >> /var/log/vaa-backup.log 2>&1
```

### Restore

Follow the "Backups & restore" section in the project `README.md` for the full restore procedure.

## SAM 3 toggle {#sam-3-toggle}

SAM 3 adds text-prompt support to the annotation canvas. To enable it:

1. Accept the [facebook/sam3](https://huggingface.co/facebook/sam3) license on Hugging Face.
2. Generate a HuggingFace access token with read permission.
3. Set in `.env`:

```env
SAM_VARIANT=sam3
HF_TOKEN=hf_...
```

4. Restart the model service: `docker compose restart model`.

**Note:** Loading SAM 3 evicts any cached YOLO weights from the model LRU cache. The first YOLO auto-annotate request after switching will reload weights from disk.

## Rate limits

The API enforces the following default rate limits:

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | 10 requests / minute |
| `POST /auth/register` | 5 requests / minute |
| `POST /weights` (YOLO upload) | 30 requests / minute |
| `POST /assets` (asset upload) | 100 requests / minute |
