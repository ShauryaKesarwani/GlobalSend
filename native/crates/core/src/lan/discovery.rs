//! UDP multicast discovery.

use std::{
    collections::HashSet,
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::Arc,
};

use socket2::{Domain, Protocol, SockRef, Socket, Type};
use tokio::net::UdpSocket;

use super::{
    Inner, LanPeer, client, local_ipv4s,
    protocol::{ANNOUNCE_INTERVAL, DeviceAnnouncement, MULTICAST_GROUP, PROTOCOL},
};

fn bind_listener(port: u16) -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // Several GlobalSend processes (or tests) on one machine must share the port.
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    socket.set_reuse_port(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port).into())?;
    UdpSocket::from_std(socket.into())
}

/// Joins the group on every interface we haven't joined yet. Called
/// periodically so we follow Wi-Fi reconnects and new interfaces.
fn join_group(socket: &UdpSocket, joined: &mut HashSet<Ipv4Addr>) {
    let ips = local_ipv4s();
    for ip in &ips {
        if !joined.contains(ip) {
            match socket.join_multicast_v4(MULTICAST_GROUP, *ip) {
                Ok(()) => {
                    joined.insert(*ip);
                }
                Err(err) => log::debug!("join multicast on {ip} failed: {err}"),
            }
        }
    }
    if joined.is_empty() && socket.join_multicast_v4(MULTICAST_GROUP, Ipv4Addr::UNSPECIFIED).is_ok() {
        joined.insert(Ipv4Addr::UNSPECIFIED);
    }
    // Forget addresses that disappeared so they are re-joined if they come back.
    joined.retain(|ip| ip.is_unspecified() || ips.contains(ip));
}

async fn send_multicast(socket: &UdpSocket, port: u16, ann: &DeviceAnnouncement) {
    let Ok(payload) = serde_json::to_vec(ann) else { return };
    let target = SocketAddr::from((MULTICAST_GROUP, port));
    let ips = local_ipv4s();
    if ips.is_empty() {
        let _ = socket.send_to(&payload, target).await;
        return;
    }
    // Send on every interface so peers on any attached network hear us.
    for ip in ips {
        if SockRef::from(socket).set_multicast_if_v4(&ip).is_ok() {
            if let Err(err) = socket.send_to(&payload, target).await {
                log::debug!("multicast via {ip} failed: {err}");
            }
        }
    }
}

fn sender_socket() -> io::Result<UdpSocket> {
    let socket = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    socket.set_multicast_loop_v4(true)?;
    socket.set_multicast_ttl_v4(1)?;
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket)
}

pub(crate) async fn run(inner: Arc<Inner>) -> io::Result<()> {
    let listener = bind_listener(inner.discovery_port)?;
    let sender = sender_socket()?;
    let mut joined = HashSet::new();
    join_group(&listener, &mut joined);

    let mut shutdown = inner.shutdown.subscribe();
    let mut ticker = tokio::time::interval(ANNOUNCE_INTERVAL);
    let mut buf = vec![0u8; 4096];

    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = ticker.tick() => {
                join_group(&listener, &mut joined);
                inner.expire_peers();
                send_multicast(&sender, inner.discovery_port, &inner.announcement(true)).await;
            }
            _ = inner.announce_now.notified() => {
                join_group(&listener, &mut joined);
                send_multicast(&sender, inner.discovery_port, &inner.announcement(true)).await;
            }
            received = listener.recv_from(&mut buf) => {
                let (len, from) = match received {
                    Ok(v) => v,
                    Err(err) => {
                        // Windows reports ICMP errors from earlier sends here; keep going.
                        log::debug!("multicast receive error: {err}");
                        continue;
                    }
                };
                handle_packet(&inner, &buf[..len], from);
            }
        }
    }
    Ok(())
}

fn handle_packet(inner: &Arc<Inner>, data: &[u8], from: SocketAddr) {
    let Ok(ann) = serde_json::from_slice::<DeviceAnnouncement>(data) else { return };
    if ann.protocol != PROTOCOL || inner.is_self(&ann.id) {
        return;
    }
    if ann.leaving {
        inner.remove_peer(&ann.id);
        return;
    }
    let peer = LanPeer::from_announcement(&ann, from.ip());
    inner.upsert_peer(peer.clone());
    if ann.announce {
        // Answer directly over HTTP; fall back to multicast if that fails
        // (e.g. the peer's firewall blocks inbound TCP but not UDP). Spawned so a
        // slow peer never stalls the receive loop.
        let inner = inner.clone();
        let addr = peer.socket_addr();
        tokio::spawn(async move {
            if client::register(&inner, addr).await.is_err() {
                if let Ok(sender) = sender_socket() {
                    send_multicast(&sender, inner.discovery_port, &inner.announcement(false)).await;
                }
            }
        });
    }
}

pub(crate) async fn announce_leaving(inner: &Inner) {
    let Ok(sender) = sender_socket() else { return };
    let mut ann = inner.announcement(false);
    ann.leaving = true;
    send_multicast(&sender, inner.discovery_port, &ann).await;
}
