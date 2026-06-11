//! Persistent store for the hosted dashboard: user accounts, browser auth
//! sessions, registered IDE "devices", and the remote-control notification
//! inbox. The live relay (`hub.rs`) stays in-memory and ephemeral; this is the
//! durable half (Postgres) that survives restarts.
//!
//! All secrets (passwords, session cookies, device tokens) are stored only as
//! hashes — argon2 for passwords, sha256 for the opaque random tokens. The raw
//! device token is shown to the user exactly once, at creation.

use serde::Serialize;
use sqlx::postgres::PgPoolOptions;
use sqlx::{FromRow, PgPool};
use std::time::{SystemTime, UNIX_EPOCH};

/// Unix seconds, now.
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

#[derive(Serialize, Clone, FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
}

#[derive(FromRow)]
struct UserAuth {
    id: String,
    email: String,
    password_hash: String,
}

#[derive(Serialize, Clone, FromRow)]
pub struct Device {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen: i64,
}

#[derive(Serialize, Clone, FromRow)]
pub struct Notification {
    pub id: String,
    pub user_id: String,
    pub device_id: String,
    pub device_name: String,
    pub agent_id: String,
    pub project: String,
    pub title: String,
    pub question: String,
    pub options: Vec<String>,
    pub text_mode: bool,
    pub kind: String,
    /// open | answered | resolved | dismissed
    pub status: String,
    pub reply_text: Option<String>,
    pub option_index: Option<i64>,
    pub created_at: i64,
    pub answered_at: Option<i64>,
    pub delivered: bool,
}

/// A reply the IDE needs to apply locally and then acknowledge.
#[derive(Serialize, Clone, FromRow)]
pub struct PendingReply {
    pub id: String,
    pub agent_id: String,
    pub reply_text: Option<String>,
    pub option_index: Option<i64>,
    pub text_mode: bool,
    pub options: Vec<String>,
}

/// Columns selected for every `Notification`, with the joined device name
/// aliased so `FromRow` maps it. Kept in one place so the SELECTs can't drift.
const NOTIF_COLS: &str = "n.id, n.user_id, n.device_id, \
    COALESCE(d.name, '(removed)') AS device_name, n.agent_id, n.project, n.title, \
    n.question, n.options, n.text_mode, n.kind, n.status, n.reply_text, \
    n.option_index, n.created_at, n.answered_at, n.delivered";

impl Db {
    /// Connect to Postgres at `database_url` and ensure the schema exists.
    pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;
        sqlx::raw_sql(SCHEMA).execute(&pool).await?;
        Ok(Self { pool })
    }

    // ---- users -----------------------------------------------------------

    pub async fn user_count(&self) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&self.pool)
            .await
    }

    pub async fn create_user(
        &self,
        email: &str,
        password_hash: &str,
    ) -> Result<User, sqlx::Error> {
        let id = new_id("usr");
        sqlx::query(
            "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
        )
        .bind(&id)
        .bind(email)
        .bind(password_hash)
        .bind(now())
        .execute(&self.pool)
        .await?;
        Ok(User {
            id,
            email: email.to_string(),
        })
    }

    /// Returns (user, password_hash) for a login attempt.
    pub async fn user_by_email(
        &self,
        email: &str,
    ) -> Result<Option<(User, String)>, sqlx::Error> {
        let row: Option<UserAuth> =
            sqlx::query_as("SELECT id, email, password_hash FROM users WHERE email = $1")
                .bind(email)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| {
            (
                User {
                    id: r.id,
                    email: r.email,
                },
                r.password_hash,
            )
        }))
    }

    // ---- auth sessions (browser cookies) ---------------------------------

    pub async fn create_session(
        &self,
        token_hash: &str,
        user_id: &str,
        expires_at: i64,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(token_hash)
        .bind(user_id)
        .bind(now())
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn user_for_session(
        &self,
        token_hash: &str,
    ) -> Result<Option<User>, sqlx::Error> {
        sqlx::query_as(
            "SELECT u.id, u.email FROM auth_sessions s \
             JOIN users u ON u.id = s.user_id \
             WHERE s.token_hash = $1 AND s.expires_at > $2",
        )
        .bind(token_hash)
        .bind(now())
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn delete_session(&self, token_hash: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM auth_sessions WHERE token_hash = $1")
            .bind(token_hash)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ---- devices (IDE instances) -----------------------------------------

    pub async fn create_device(
        &self,
        user_id: &str,
        name: &str,
        token_hash: &str,
    ) -> Result<Device, sqlx::Error> {
        let id = new_id("dev");
        let t = now();
        sqlx::query(
            "INSERT INTO devices (id, user_id, name, token_hash, created_at, last_seen) \
             VALUES ($1, $2, $3, $4, $5, $5)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(name)
        .bind(token_hash)
        .bind(t)
        .execute(&self.pool)
        .await?;
        Ok(Device {
            id,
            user_id: user_id.to_string(),
            name: name.to_string(),
            created_at: t,
            last_seen: t,
        })
    }

    pub async fn list_devices(&self, user_id: &str) -> Result<Vec<Device>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, user_id, name, created_at, last_seen FROM devices \
             WHERE user_id = $1 ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn device_for_token(
        &self,
        token_hash: &str,
    ) -> Result<Option<Device>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, user_id, name, created_at, last_seen FROM devices \
             WHERE token_hash = $1",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn delete_device(&self, user_id: &str, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM devices WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn touch_device(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE devices SET last_seen = $2 WHERE id = $1")
            .bind(id)
            .bind(now())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ---- notifications ---------------------------------------------------

    /// Create (or refresh) the single open notification for a given agent on a
    /// device. The IDE re-posts as the question/options change, so a partial
    /// unique index collapses to one open row per (device, agent) instead of
    /// spamming the inbox. Returns the notification id.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_open_notification(
        &self,
        user_id: &str,
        device_id: &str,
        agent_id: &str,
        project: &str,
        title: &str,
        question: &str,
        options: &[String],
        text_mode: bool,
        kind: &str,
    ) -> Result<String, sqlx::Error> {
        let id = new_id("ntf");
        sqlx::query_scalar(
            "INSERT INTO notifications \
             (id, user_id, device_id, agent_id, project, title, question, options, \
              text_mode, kind, status, created_at, delivered) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11,false) \
             ON CONFLICT (device_id, agent_id) WHERE status = 'open' \
             DO UPDATE SET project = EXCLUDED.project, title = EXCLUDED.title, \
              question = EXCLUDED.question, options = EXCLUDED.options, \
              text_mode = EXCLUDED.text_mode, kind = EXCLUDED.kind \
             RETURNING id",
        )
        .bind(&id)
        .bind(user_id)
        .bind(device_id)
        .bind(agent_id)
        .bind(project)
        .bind(title)
        .bind(question)
        .bind(options)
        .bind(text_mode)
        .bind(kind)
        .bind(now())
        .fetch_one(&self.pool)
        .await
    }

    /// The agent stopped waiting locally — clear any open prompts for it so the
    /// remote inbox doesn't show a stale question.
    pub async fn resolve_open_for_agent(
        &self,
        device_id: &str,
        agent_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE notifications SET status = 'resolved' \
             WHERE device_id = $1 AND agent_id = $2 AND status = 'open'",
        )
        .bind(device_id)
        .bind(agent_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_notifications(
        &self,
        user_id: &str,
        only_open: bool,
        limit: i64,
    ) -> Result<Vec<Notification>, sqlx::Error> {
        let sql = format!(
            "SELECT {NOTIF_COLS} FROM notifications n \
             LEFT JOIN devices d ON d.id = n.device_id \
             WHERE n.user_id = $1 {} ORDER BY n.created_at DESC LIMIT $2",
            if only_open { "AND n.status = 'open'" } else { "" }
        );
        sqlx::query_as(&sql)
            .bind(user_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await
    }

    pub async fn notification_owned(
        &self,
        user_id: &str,
        id: &str,
    ) -> Result<Option<Notification>, sqlx::Error> {
        let sql = format!(
            "SELECT {NOTIF_COLS} FROM notifications n \
             LEFT JOIN devices d ON d.id = n.device_id \
             WHERE n.id = $1 AND n.user_id = $2",
        );
        sqlx::query_as(&sql)
            .bind(id)
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await
    }

    /// Record the user's answer; the device picks it up on its next poll.
    /// Returns rows affected (0 if it wasn't open / not theirs).
    pub async fn answer_notification(
        &self,
        user_id: &str,
        id: &str,
        reply_text: Option<&str>,
        option_index: Option<i64>,
    ) -> Result<u64, sqlx::Error> {
        let res = sqlx::query(
            "UPDATE notifications SET status='answered', reply_text=$3, option_index=$4, \
             answered_at=$5, delivered=false WHERE id=$1 AND user_id=$2 AND status='open'",
        )
        .bind(id)
        .bind(user_id)
        .bind(reply_text)
        .bind(option_index)
        .bind(now())
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    pub async fn dismiss_notification(
        &self,
        user_id: &str,
        id: &str,
    ) -> Result<u64, sqlx::Error> {
        let res = sqlx::query(
            "UPDATE notifications SET status='dismissed' \
             WHERE id=$1 AND user_id=$2 AND status='open'",
        )
        .bind(id)
        .bind(user_id)
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    /// Answers this device hasn't applied yet.
    pub async fn pending_replies(
        &self,
        device_id: &str,
    ) -> Result<Vec<PendingReply>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, agent_id, reply_text, option_index, text_mode, options \
             FROM notifications WHERE device_id=$1 AND status='answered' AND delivered=false \
             ORDER BY answered_at ASC",
        )
        .bind(device_id)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn mark_delivered(
        &self,
        device_id: &str,
        ids: &[String],
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE notifications SET delivered=true WHERE device_id=$1 AND id = ANY($2)",
        )
        .bind(device_id)
        .bind(ids)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

/// A short, collision-resistant id with a type prefix (e.g. `usr_a1b2…`).
fn new_id(prefix: &str) -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    last_seen  BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    project      TEXT NOT NULL DEFAULT '',
    title        TEXT NOT NULL DEFAULT '',
    question     TEXT NOT NULL DEFAULT '',
    options      TEXT[] NOT NULL DEFAULT '{}',
    text_mode    BOOLEAN NOT NULL DEFAULT false,
    kind         TEXT NOT NULL DEFAULT 'waiting',
    status       TEXT NOT NULL DEFAULT 'open',
    reply_text   TEXT,
    option_index BIGINT,
    created_at   BIGINT NOT NULL,
    answered_at  BIGINT,
    delivered    BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_open_agent
    ON notifications(device_id, agent_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_device ON notifications(device_id, status, delivered);
";
