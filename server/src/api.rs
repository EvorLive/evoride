//! HTTP API for the hosted dashboard at evor.dev.
//!
//! Two audiences, two auth schemes:
//!   * The **browser** (Next.js dashboard) authenticates with an HttpOnly
//!     session cookie set on login. Routes under `/api/*`.
//!   * The **IDE** ("device") authenticates with a bearer token issued in the
//!     dashboard. Routes under `/device/*`. The IDE posts agent-waiting
//!     notifications and polls for the replies the user made remotely.
//!
//! The relay's WebSocket routes (`/produce`, `/view`, `/control`) are untouched
//! and live in `main.rs`.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{Device, Notification, PendingReply, User, now};
use crate::hub::AppState;

const SESSION_COOKIE: &str = "evor_session";
const SESSION_TTL_SECS: i64 = 60 * 60 * 24 * 30; // 30 days

/// All dashboard + device routes, to be merged onto the relay router.
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        // Browser / dashboard (cookie auth)
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        .route("/api/devices", get(list_devices).post(create_device))
        .route("/api/devices/{id}", delete(remove_device))
        .route("/api/notifications", get(list_notifications))
        .route("/api/notifications/{id}/reply", post(reply_notification))
        .route("/api/notifications/{id}/dismiss", post(dismiss_notification))
        // IDE / device (bearer token auth)
        .route("/device/notify", post(device_notify))
        .route("/device/resolve", post(device_resolve))
        .route("/device/poll", get(device_poll))
        .route("/device/ack", post(device_ack))
}

// ---- error type ----------------------------------------------------------

pub enum ApiError {
    Unauthorized,
    BadRequest(String),
    NotFound,
    Conflict(String),
    Internal(String),
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &e {
            if db.is_unique_violation() {
                return ApiError::Conflict("already exists".into());
            }
        }
        ApiError::Internal(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m),
            ApiError::Internal(m) => {
                eprintln!("api error: {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

// ---- request/response shapes --------------------------------------------

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

#[derive(Serialize)]
struct MeResp {
    email: String,
}

#[derive(Deserialize)]
struct CreateDeviceReq {
    name: Option<String>,
}

#[derive(Serialize)]
struct CreateDeviceResp {
    device: Device,
    /// Plaintext token — shown to the user exactly once.
    token: String,
}

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
}

#[derive(Deserialize)]
struct ReplyReq {
    reply_text: Option<String>,
    option_index: Option<i64>,
}

#[derive(Deserialize)]
struct NotifyReq {
    agent_id: String,
    project: Option<String>,
    title: Option<String>,
    question: Option<String>,
    options: Option<Vec<String>>,
    text_mode: Option<bool>,
    kind: Option<String>,
}

#[derive(Serialize)]
struct NotifyResp {
    id: String,
}

#[derive(Deserialize)]
struct ResolveReq {
    agent_id: String,
}

#[derive(Deserialize)]
struct AckReq {
    ids: Vec<String>,
}

// ---- browser/dashboard handlers -----------------------------------------

async fn register(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(body): Json<Credentials>,
) -> ApiResult<(CookieJar, Json<MeResp>)> {
    let email = body.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(ApiError::BadRequest("enter a valid email".into()));
    }
    if body.password.len() < 8 {
        return Err(ApiError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    let hash = hash_password(&body.password)?;
    let user = state
        .db
        .create_user(&email, &hash)
        .await
        .map_err(|e| match ApiError::from(e) {
            ApiError::Conflict(_) => ApiError::Conflict("an account with that email exists".into()),
            other => other,
        })?;
    let jar = start_session(&state, jar, &user).await?;
    Ok((jar, Json(MeResp { email: user.email })))
}

async fn login(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(body): Json<Credentials>,
) -> ApiResult<(CookieJar, Json<MeResp>)> {
    let email = body.email.trim().to_lowercase();
    let (user, hash) = state
        .db
        .user_by_email(&email)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if !verify_password(&body.password, &hash) {
        return Err(ApiError::Unauthorized);
    }
    let jar = start_session(&state, jar, &user).await?;
    Ok((jar, Json(MeResp { email: user.email })))
}

async fn logout(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<(CookieJar, Json<Value>)> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        let _ = state.db.delete_session(&hash_token(c.value())).await;
    }
    let jar = jar.remove(Cookie::from(SESSION_COOKIE));
    Ok((jar, Json(json!({ "ok": true }))))
}

async fn me(State(state): State<Arc<AppState>>, jar: CookieJar) -> ApiResult<Json<MeResp>> {
    let user = require_user(&state, &jar).await?;
    Ok(Json(MeResp { email: user.email }))
}

async fn list_devices(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
) -> ApiResult<Json<Vec<Device>>> {
    let user = require_user(&state, &jar).await?;
    Ok(Json(state.db.list_devices(&user.id).await?))
}

async fn create_device(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(body): Json<CreateDeviceReq>,
) -> ApiResult<Json<CreateDeviceResp>> {
    let user = require_user(&state, &jar).await?;
    let name = body.name.unwrap_or_default();
    let name = name.trim();
    let name = if name.is_empty() { "My IDE" } else { name };
    let token = format!("evor_{}", gen_token());
    let device = state
        .db
        .create_device(&user.id, name, &hash_token(&token))
        .await?;
    Ok(Json(CreateDeviceResp { device, token }))
}

async fn remove_device(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = require_user(&state, &jar).await?;
    state.db.delete_device(&user.id, &id).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn list_notifications(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<Notification>>> {
    let user = require_user(&state, &jar).await?;
    let only_open = q.status.as_deref() == Some("open");
    Ok(Json(
        state.db.list_notifications(&user.id, only_open, 200).await?,
    ))
}

async fn reply_notification(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(id): Path<String>,
    Json(body): Json<ReplyReq>,
) -> ApiResult<Json<Value>> {
    let user = require_user(&state, &jar).await?;
    let reply_text = body.reply_text.map(|s| clamp(s, 4000));
    if reply_text.is_none() && body.option_index.is_none() {
        return Err(ApiError::BadRequest(
            "reply_text or option_index required".into(),
        ));
    }
    let rows = state
        .db
        .answer_notification(&user.id, &id, reply_text.as_deref(), body.option_index)
        .await?;
    if rows == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn dismiss_notification(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let user = require_user(&state, &jar).await?;
    let rows = state.db.dismiss_notification(&user.id, &id).await?;
    if rows == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(json!({ "ok": true })))
}

// ---- device/IDE handlers -------------------------------------------------

async fn device_notify(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<NotifyReq>,
) -> ApiResult<Json<NotifyResp>> {
    let device = require_device(&state, &headers).await?;
    let _ = state.db.touch_device(&device.id).await;
    if body.agent_id.trim().is_empty() {
        return Err(ApiError::BadRequest("agent_id required".into()));
    }
    let options: Vec<String> = body
        .options
        .unwrap_or_default()
        .into_iter()
        .take(20)
        .map(|s| clamp(s, 300))
        .collect();
    let id = state
        .db
        .upsert_open_notification(
            &device.user_id,
            &device.id,
            body.agent_id.trim(),
            &clamp(body.project.unwrap_or_default(), 200),
            &clamp(body.title.unwrap_or_default(), 200),
            &clamp(body.question.unwrap_or_default(), 4000),
            &options,
            body.text_mode.unwrap_or(false),
            &clamp(body.kind.unwrap_or_else(|| "waiting".into()), 40),
        )
        .await?;
    Ok(Json(NotifyResp { id }))
}

async fn device_resolve(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ResolveReq>,
) -> ApiResult<Json<Value>> {
    let device = require_device(&state, &headers).await?;
    let _ = state.db.touch_device(&device.id).await;
    state
        .db
        .resolve_open_for_agent(&device.id, body.agent_id.trim())
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn device_poll(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<PendingReply>>> {
    let device = require_device(&state, &headers).await?;
    let _ = state.db.touch_device(&device.id).await;
    Ok(Json(state.db.pending_replies(&device.id).await?))
}

async fn device_ack(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<AckReq>,
) -> ApiResult<Json<Value>> {
    let device = require_device(&state, &headers).await?;
    if !body.ids.is_empty() {
        state.db.mark_delivered(&device.id, &body.ids).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

// ---- auth helpers --------------------------------------------------------

async fn require_user(state: &AppState, jar: &CookieJar) -> ApiResult<User> {
    let token = jar
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .ok_or(ApiError::Unauthorized)?;
    state
        .db
        .user_for_session(&hash_token(&token))
        .await?
        .ok_or(ApiError::Unauthorized)
}

async fn require_device(state: &AppState, headers: &HeaderMap) -> ApiResult<Device> {
    let auth = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth.strip_prefix("Bearer ").ok_or(ApiError::Unauthorized)?;
    state
        .db
        .device_for_token(&hash_token(token.trim()))
        .await?
        .ok_or(ApiError::Unauthorized)
}

/// Issue a session token, persist its hash, and attach the cookie.
async fn start_session(state: &AppState, jar: CookieJar, user: &User) -> ApiResult<CookieJar> {
    let token = gen_token();
    state
        .db
        .create_session(&hash_token(&token), &user.id, now() + SESSION_TTL_SECS)
        .await?;
    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(cookie_secure())
        .permanent()
        .build();
    Ok(jar.add(cookie))
}

/// Whether to mark the session cookie `Secure`. Off by default for local dev
/// over http; set `EVOR_COOKIE_SECURE=1` behind TLS in production.
fn cookie_secure() -> bool {
    matches!(
        std::env::var("EVOR_COOKIE_SECURE").as_deref(),
        Ok("1") | Ok("true")
    )
}

fn hash_password(pw: &str) -> ApiResult<String> {
    use argon2::password_hash::{SaltString, rand_core::OsRng};
    use argon2::{Argon2, PasswordHasher};
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError::Internal(e.to_string()))
}

fn verify_password(pw: &str, hash: &str) -> bool {
    use argon2::password_hash::PasswordHash;
    use argon2::{Argon2, PasswordVerifier};
    match PasswordHash::new(hash) {
        Ok(ph) => Argon2::default()
            .verify_password(pw.as_bytes(), &ph)
            .is_ok(),
        Err(_) => false,
    }
}

/// 32 random bytes, hex-encoded — used for session and device tokens.
fn gen_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

/// sha256(token) hex — tokens are only ever stored hashed.
fn hash_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

/// Truncate to at most `max` chars on a char boundary (untrusted input bound).
fn clamp(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        s
    } else {
        s.chars().take(max).collect()
    }
}
