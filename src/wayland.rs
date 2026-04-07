//! `wayland.rs` — Wayland connection and wlr-layer-shell surface management.
//!
//! Responsibilities:
//! - Establish the Wayland connection and event queue
//! - Enumerate outputs (monitors) via the xdg-output or wl_output protocol
//! - Create one `zwlr_layer_surface_v1` overlay surface per output
//! - Handle output hotplug: add surfaces for new monitors, destroy for removed ones
//! - Forward keyboard/pointer/touch events to the dismiss logic in main.rs
//! - Manage per-surface scale factors for HiDPI rendering

use smithay_client_toolkit::reexports::client::{
    protocol::{wl_output::WlOutput, wl_seat::WlSeat, wl_surface::WlSurface},
    Connection, EventQueue,
};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_layer, delegate_output, delegate_registry, delegate_seat,
    delegate_keyboard, delegate_pointer,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{
        keyboard::{KeyboardHandler, KeyEvent},
        pointer::{PointerHandler, PointerEvent},
        SeatHandler, SeatState,
    },
    shell::wlr_layer::{
        Layer, LayerShell, LayerShellHandler, LayerSurface, LayerSurfaceConfigure,
    },
};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Surface — one per monitor
// ---------------------------------------------------------------------------

/// Represents one wlr-layer-shell overlay surface bound to a single Wayland output.
#[derive(Debug)]
pub struct Surface {
    /// The underlying Wayland surface.
    pub wl_surface: WlSurface,

    /// The layer-shell surface handle.
    pub layer_surface: LayerSurface,

    /// Width in logical pixels (before scale factor).
    pub width: u32,

    /// Height in logical pixels (before scale factor).
    pub height: u32,

    /// Output scale factor (1 = normal, 2 = HiDPI ×2, etc.).
    pub scale_factor: i32,

    /// Whether the surface has been configured by the compositor yet.
    pub configured: bool,

    /// Opaque handle to the GL context for this surface. Managed by renderer.rs.
    pub gl_context_handle: Option<usize>,
}

impl Surface {
    /// Physical pixel width (logical × scale).
    pub fn phys_width(&self) -> u32 {
        self.width * self.scale_factor.max(1) as u32
    }

    /// Physical pixel height (logical × scale).
    pub fn phys_height(&self) -> u32 {
        self.height * self.scale_factor.max(1) as u32
    }
}

// ---------------------------------------------------------------------------
// WaylandState — owns the connection and all protocol objects
// ---------------------------------------------------------------------------

/// Central state object passed into all SCTK delegate implementations.
/// Holds every Wayland protocol object and the list of active surfaces.
pub struct WaylandState {
    /// SCTK registry state (wl_registry bookkeeping).
    pub registry_state: RegistryState,

    /// SCTK output state (tracks wl_output objects).
    pub output_state: OutputState,

    /// SCTK compositor state (wl_compositor, wl_subcompositor).
    pub compositor_state: CompositorState,

    /// SCTK seat state (keyboard, pointer, touch).
    pub seat_state: SeatState,

    /// wlr-layer-shell global.
    pub layer_shell: LayerShell,

    /// Active surfaces, keyed by the `WlOutput` they cover.
    pub surfaces: HashMap<WlOutput, Surface>,

    /// Set to true when any dismiss event is received (key, mouse move, etc.).
    pub should_exit: bool,

    /// Target layer for the screensaver overlay.
    pub layer: Layer,
}

impl WaylandState {
    /// Connect to the Wayland compositor and bind all required globals.
    pub fn connect() -> anyhow::Result<(Self, Connection, EventQueue<Self>)> {
        todo!(
            "call Connection::connect_to_env(), create EventQueue, \
             init RegistryState and bind CompositorState, OutputState, SeatState, \
             LayerShell; return (Self, conn, queue)"
        )
    }

    /// Create one layer-shell overlay surface for every currently known output.
    pub fn create_surfaces(&mut self) -> anyhow::Result<()> {
        todo!(
            "iterate self.output_state.outputs(), for each create a WlSurface + \
             LayerSurface (Layer::Overlay, anchor all edges, exclusive_zone -1), \
             insert into self.surfaces"
        )
    }

    /// Destroy all surfaces and release protocol objects.
    pub fn destroy_surfaces(&mut self) {
        todo!("call layer_surface.destroy() and wl_surface.destroy() for each surface")
    }

    /// Process pending Wayland events without blocking. Returns whether any events were dispatched.
    pub fn handle_events(
        &mut self,
        queue: &mut EventQueue<Self>,
    ) -> anyhow::Result<bool> {
        todo!(
            "call queue.dispatch_pending(self), return Ok(dispatched > 0)"
        )
    }
}

// ---------------------------------------------------------------------------
// SCTK delegate impls (stubs)
// ---------------------------------------------------------------------------

impl CompositorHandler for WaylandState {
    fn surface_enter(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _surface: &WlSurface,
        _output: &WlOutput,
    ) {
        // Track which output each surface is on if needed in future.
    }

    fn surface_leave(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _surface: &WlSurface,
        _output: &WlOutput,
    ) {
        // No action needed for screensaver use case.
    }

    fn scale_factor_changed(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        surface: &WlSurface,
        new_factor: i32,
    ) {
        todo!(
            "find the Surface whose wl_surface matches, update scale_factor, \
             mark surface as needing resize"
        )
    }

    fn transform_changed(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _surface: &WlSurface,
        _new_transform: smithay_client_toolkit::reexports::client::protocol::wl_output::Transform,
    ) {
        // Not handled in v0.1.0.
    }

    fn frame(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _surface: &WlSurface,
        _time: u32,
    ) {
        // Frame callbacks are handled in the render loop, not here.
    }
}

impl OutputHandler for WaylandState {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output_state
    }

    fn new_output(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        output: WlOutput,
    ) {
        todo!("create a new Surface for this output and insert into self.surfaces")
    }

    fn update_output(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _output: WlOutput,
    ) {
        todo!("update dimensions / scale factor for the corresponding Surface")
    }

    fn output_destroyed(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        output: WlOutput,
    ) {
        todo!("remove and destroy the Surface for this output from self.surfaces")
    }
}

impl LayerShellHandler for WaylandState {
    fn closed(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _layer: &LayerSurface,
    ) {
        todo!("compositor closed the layer surface; set self.should_exit = true")
    }

    fn configure(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _serial: u32,
    ) {
        todo!(
            "find the Surface for this layer, update width/height from configure.new_size, \
             set configured = true, ack the configure"
        )
    }
}

impl SeatHandler for WaylandState {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seat_state
    }

    fn new_seat(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _seat: WlSeat,
    ) {
        todo!("bind keyboard and pointer capabilities for the new seat")
    }

    fn new_capability(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _seat: WlSeat,
        _capability: smithay_client_toolkit::seat::Capability,
    ) {
        todo!("on Keyboard capability, get_keyboard(); on Pointer, get_pointer()")
    }

    fn remove_capability(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _seat: WlSeat,
        _capability: smithay_client_toolkit::seat::Capability,
    ) {
        // Release keyboard/pointer objects when compositor removes the capability.
    }

    fn remove_seat(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _seat: WlSeat,
    ) {
        // Nothing to do for v0.1.0.
    }
}

impl KeyboardHandler for WaylandState {
    fn enter(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _keyboard: &smithay_client_toolkit::reexports::client::protocol::wl_keyboard::WlKeyboard,
        _surface: &WlSurface,
        _serial: u32,
        _raw: &[u32],
        _keysyms: &[smithay_client_toolkit::seat::keyboard::Keysym],
    ) {
        // No action on focus enter.
    }

    fn leave(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _keyboard: &smithay_client_toolkit::reexports::client::protocol::wl_keyboard::WlKeyboard,
        _surface: &WlSurface,
        _serial: u32,
    ) {
        // No action on focus leave.
    }

    fn press_key(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _keyboard: &smithay_client_toolkit::reexports::client::protocol::wl_keyboard::WlKeyboard,
        _serial: u32,
        _event: KeyEvent,
    ) {
        todo!("set self.should_exit = true if DismissEvent::Key is configured")
    }

    fn release_key(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _keyboard: &smithay_client_toolkit::reexports::client::protocol::wl_keyboard::WlKeyboard,
        _serial: u32,
        _event: KeyEvent,
    ) {
        // Dismiss on press, not release.
    }

    fn update_modifiers(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _keyboard: &smithay_client_toolkit::reexports::client::protocol::wl_keyboard::WlKeyboard,
        _serial: u32,
        _modifiers: smithay_client_toolkit::seat::keyboard::Modifiers,
        _layout: u32,
    ) {
        // Not needed for screensaver dismiss logic.
    }
}

impl PointerHandler for WaylandState {
    fn pointer_frame(
        &mut self,
        _conn: &Connection,
        _qh: &smithay_client_toolkit::reexports::client::QueueHandle<Self>,
        _pointer: &smithay_client_toolkit::reexports::client::protocol::wl_pointer::WlPointer,
        events: &[PointerEvent],
    ) {
        todo!(
            "iterate events; on Motion set should_exit if MouseMove configured; \
             on Button set should_exit if MouseClick configured"
        )
    }
}

impl ProvidesRegistryState for WaylandState {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry_state
    }

    registry_handlers![OutputState, SeatState];
}

// SCTK macro-generated delegate glue.
delegate_compositor!(WaylandState);
delegate_output!(WaylandState);
delegate_layer!(WaylandState);
delegate_seat!(WaylandState);
delegate_keyboard!(WaylandState);
delegate_pointer!(WaylandState);
delegate_registry!(WaylandState);
