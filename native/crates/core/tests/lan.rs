//! End-to-end LAN tests: two engines in one process talking over loopback.

use std::{
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};

use globalsend_core::{
    device::Platform,
    lan::{Direction, LanConfig, LanEngine, LanEvent, OutgoingFile},
    tap::TapAuth,
};
use tokio::sync::mpsc::UnboundedReceiver;

struct Node {
    engine: LanEngine,
    events: UnboundedReceiver<LanEvent>,
    tap: Arc<TapAuth>,
    id: String,
    dir: tempfile::TempDir,
}

async fn node(alias: &str, discovery_port: Option<u16>) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let id = uuid_like(alias);
    let config = LanConfig {
        device_id: id.clone(),
        alias: alias.to_owned(),
        platform: Platform::Windows,
        download_dir: dir.path().join("received"),
        port: 0,
        discovery_port: discovery_port.unwrap_or(0),
        discovery: discovery_port.is_some(),
    };
    let tap = Arc::new(TapAuth::new());
    let (engine, events) = LanEngine::start(config, tap.clone()).await.unwrap();
    Node { engine, events, tap, id, dir }
}

fn uuid_like(alias: &str) -> String {
    format!("{alias}-{:x}", rand_u64())
}

fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(std::time::SystemTime::now())
}

fn addr(node: &Node) -> SocketAddr {
    SocketAddr::from((Ipv4Addr::LOCALHOST, node.engine.port()))
}

async fn next_matching<F: FnMut(&LanEvent) -> bool>(
    events: &mut UnboundedReceiver<LanEvent>,
    mut pred: F,
) -> LanEvent {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.expect("engine stopped");
            if pred(&event) {
                return event;
            }
        }
    })
    .await
    .expect("timed out waiting for event")
}

fn outgoing(dir: &Path, name: &str, bytes: &[u8]) -> OutgoingFile {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    OutgoingFile {
        name: name.to_owned(),
        size: bytes.len() as u64,
        mime_type: "application/octet-stream".into(),
        file: std::fs::File::open(path).unwrap(),
    }
}

fn finished(event: &LanEvent, dir: Direction) -> Option<(bool, Option<String>)> {
    match event {
        LanEvent::TransferFinished { direction, ok, error, .. } if *direction == dir => Some((*ok, error.clone())),
        _ => None,
    }
}

#[tokio::test]
async fn tap_token_skips_prompt_and_transfers_files() {
    let mut a = node("alpha", None).await;
    let mut b = node("bravo", None).await;
    let peer = a.engine.probe(addr(&b), Some(&b.id)).await.unwrap();
    assert_eq!(peer.alias, "bravo");

    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let files = vec![outgoing(a.dir.path(), "big.bin", &big), outgoing(a.dir.path(), "note.txt", b"hello")];
    a.engine.send_files(&b.id, files, Some(b.tap.issue())).unwrap();

    let started = next_matching(&mut b.events, |e| matches!(e, LanEvent::TransferStarted { .. } | LanEvent::IncomingRequest { .. })).await;
    assert!(matches!(started, LanEvent::TransferStarted { auto_accepted: true, .. }), "got {started:?}");
    let (ok, err) = finished(&next_matching(&mut b.events, |e| finished(e, Direction::Receive).is_some()).await, Direction::Receive).unwrap();
    assert!(ok, "receive failed: {err:?}");
    let (ok, err) = finished(&next_matching(&mut a.events, |e| finished(e, Direction::Send).is_some()).await, Direction::Send).unwrap();
    assert!(ok, "send failed: {err:?}");

    let received = b.dir.path().join("received");
    assert_eq!(std::fs::read(received.join("big.bin")).unwrap(), big);
    assert_eq!(std::fs::read(received.join("note.txt")).unwrap(), b"hello");
    let leftovers: Vec<_> = std::fs::read_dir(&received).unwrap().filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".gspart")).collect();
    assert!(leftovers.is_empty());
}

#[tokio::test]
async fn without_token_receiver_is_asked() {
    let mut a = node("alpha", None).await;
    let mut b = node("bravo", None).await;
    a.engine.probe(addr(&b), None).await.unwrap();

    // Declined.
    a.engine.send_files(&b.id, vec![outgoing(a.dir.path(), "x.txt", b"x")], None).unwrap();
    let LanEvent::IncomingRequest { request_id, from, files, .. } =
        next_matching(&mut b.events, |e| matches!(e, LanEvent::IncomingRequest { .. })).await
    else { unreachable!() };
    assert_eq!(from.alias, "alpha");
    assert_eq!(files[0].name, "x.txt");
    assert!(b.engine.respond(&request_id, false));
    let (ok, err) = finished(&next_matching(&mut a.events, |e| finished(e, Direction::Send).is_some()).await, Direction::Send).unwrap();
    assert!(!ok);
    assert_eq!(err.as_deref(), Some("declined"));

    // Accepted, and a name collision gets a suffix instead of overwriting.
    let received = b.dir.path().join("received");
    std::fs::create_dir_all(&received).unwrap();
    std::fs::write(received.join("y.txt"), b"old").unwrap();
    a.engine.send_files(&b.id, vec![outgoing(a.dir.path(), "y.txt", b"new")], None).unwrap();
    let LanEvent::IncomingRequest { request_id, .. } =
        next_matching(&mut b.events, |e| matches!(e, LanEvent::IncomingRequest { .. })).await
    else { unreachable!() };
    assert!(b.engine.respond(&request_id, true));
    let (ok, err) = finished(&next_matching(&mut a.events, |e| finished(e, Direction::Send).is_some()).await, Direction::Send).unwrap();
    assert!(ok, "{err:?}");
    assert_eq!(std::fs::read(received.join("y.txt")).unwrap(), b"old");
    assert_eq!(std::fs::read(received.join("y (1).txt")).unwrap(), b"new");
}

#[tokio::test]
async fn replayed_or_foreign_token_falls_back_to_prompt() {
    let a = node("alpha", None).await;
    let mut b = node("bravo", None).await;
    a.engine.probe(addr(&b), None).await.unwrap();

    let token = b.tap.issue();
    assert!(b.tap.verify_and_consume(&token).is_ok()); // already used once
    a.engine.send_files(&b.id, vec![outgoing(a.dir.path(), "z.txt", b"z")], Some(token)).unwrap();
    let event = next_matching(&mut b.events, |e| matches!(e, LanEvent::IncomingRequest { .. } | LanEvent::TransferStarted { .. })).await;
    assert!(matches!(event, LanEvent::IncomingRequest { .. }), "replayed token must not auto-accept");
}

#[tokio::test]
async fn probe_rejects_wrong_device() {
    let a = node("alpha", None).await;
    let b = node("bravo", None).await;
    assert!(a.engine.probe(addr(&b), Some("someone-else")).await.is_err());
}

#[tokio::test]
async fn multicast_discovery_finds_peers() {
    let port = 40_000 + (rand_u64() % 20_000) as u16;
    let mut a = node("alpha", Some(port)).await;
    let b = node("bravo", Some(port)).await;
    let b_id = b.id.clone();
    let event = next_matching(&mut a.events, |e| {
        matches!(e, LanEvent::PeersChanged { peers } if peers.iter().any(|p| p.id == b_id))
    })
    .await;
    let LanEvent::PeersChanged { peers } = event else { unreachable!() };
    assert_eq!(peers.iter().find(|p| p.id == b_id).unwrap().alias, "bravo");

    // Leaving removes the peer right away.
    b.engine.shutdown().await;
    next_matching(&mut a.events, |e| matches!(e, LanEvent::PeersChanged { peers } if !peers.iter().any(|p| p.id == b_id))).await;
}
