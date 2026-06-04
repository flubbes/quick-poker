import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { readFileSync } from "fs";
import { resolve } from "path";

interface MockSocket {
  id: string;
  connected: boolean;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  _listeners: Record<string, Function[]>;
  _callbacks: Record<string, Function>;
  trigger: (event: string, ...args: any[]) => void;
  triggerCallback: (event: string, ...args: any[]) => void;
}

function createMockSocket(): MockSocket {
  const listeners: Record<string, Function[]> = {};
  const callbacks: Record<string, Function> = {};

  const socket: MockSocket = {
    id: "mock-socket-id",
    connected: true,
    emit: vi.fn((event: string, ...args: any[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        callbacks[event] = last;
      }
    }),
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    disconnect: vi.fn(),
    connect: vi.fn(),
    _listeners: listeners,
    _callbacks: callbacks,
    trigger(event: string, ...args: any[]) {
      listeners[event]?.forEach((h) => h(...args));
    },
    triggerCallback(event: string, ...args: any[]) {
      callbacks[event]?.(...args);
    },
  };

  return socket;
}

let mockSocket: MockSocket;
let localStorageData: Record<string, string>;
let sessionStorageData: Record<string, string>;
let originalLocation: typeof window.location;

// Read and cache the app template from index.html
const indexHtml = readFileSync(resolve(__dirname, "../public/index.html"), "utf-8");
const appTemplateMatch = indexHtml.match(/<div id="app">([\s\S]*?)<\/div>\s*<script/);
const appTemplateInner = appTemplateMatch ? appTemplateMatch[1] : "";
const appTemplate = appTemplateMatch
  ? appTemplateMatch[0].replace(/\s*<script[\s\S]*/, "")
  : '<div id="app"></div>';

describe("Frontend", () => {
  beforeEach(() => {
    mockSocket = createMockSocket();
    localStorageData = {};
    sessionStorageData = {};

    (globalThis as any).io = vi.fn(() => mockSocket);
    (globalThis as any).Vue = { createApp: vi.fn(() => ({ mount: vi.fn() })) };

    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (k: string) => localStorageData[k] || null,
        setItem: (k: string, v: string) => {
          localStorageData[k] = v;
        },
      },
      writable: true,
    });

    Object.defineProperty(globalThis, "sessionStorage", {
      value: {
        getItem: (k: string) => sessionStorageData[k] || null,
        setItem: (k: string, v: string) => {
          sessionStorageData[k] = v;
        },
      },
      writable: true,
    });

    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      writable: true,
      value: { hash: "" },
    });

    (globalThis as any).alert = vi.fn();

    // Set up the DOM template so Vue can compile it
    document.body.innerHTML = appTemplate;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
    Object.defineProperty(window, "location", {
      writable: true,
      value: originalLocation,
    });
  });

  async function loadAppOptions() {
    const mod = await import("../public/app.ts");
    const options = mod.appOptions as any;
    options.template = appTemplateInner;
    return options;
  }

  // ========================================================================
  // MOUNT & JOIN
  // ========================================================================

  it("mounts and emits join on mounted with a stable userId", async () => {
    const appOptions = await loadAppOptions();
    mount(appOptions);
    await flushPromises();
    expect(mockSocket.emit).toHaveBeenCalledWith(
      "join",
      "",
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      expect.any(Function),
    );
  });

  it("reuses the userId from localStorage across mounts", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();
    const firstUserId = localStorageData["qp-user-id"];
    expect(firstUserId).toMatch(/^[0-9a-f-]{36}$/i);

    wrapper.unmount();
    const wrapper2 = mount(appOptions);
    await flushPromises();
    expect(localStorageData["qp-user-id"]).toBe(firstUserId);
    wrapper2.unmount();
  });

  it("reuses the per-tab sessionId from sessionStorage across mounts", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();
    const firstSessionId = sessionStorageData["qp-session-id"];
    expect(firstSessionId).toMatch(/^[0-9a-f-]{36}$/i);

    wrapper.unmount();
    const wrapper2 = mount(appOptions);
    await flushPromises();
    expect(sessionStorageData["qp-session-id"]).toBe(firstSessionId);
    wrapper2.unmount();
  });

  it("sets location hash and emits setName after join callback", async () => {
    const appOptions = await loadAppOptions();
    mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "test-lobby-id");
    await flushPromises();

    expect(window.location.hash).toBe("test-lobby-id");
    expect(mockSocket.emit).toHaveBeenCalledWith("setName", "test-lobby-id", "Anonymous");
  });

  it("emits setPO after join callback when po is true", async () => {
    localStorageData["qp-name"] = "Alice";
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    (wrapper.vm as any).po = true;
    mockSocket.triggerCallback("join", "lobby-po");
    await flushPromises();

    expect(mockSocket.emit).toHaveBeenCalledWith("setPO", "lobby-po", true);
  });

  it("shows alert when join returns null", async () => {
    const appOptions = await loadAppOptions();
    mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", null);
    await flushPromises();

    expect((globalThis as any).alert).toHaveBeenCalledWith(
      "Failed to create or join lobby. Please try again later.",
    );
  });

  it("reads name from localStorage on init", async () => {
    localStorageData["qp-name"] = "Bob";
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    expect((wrapper.vm as any).name).toBe("Bob");
  });

  // ========================================================================
  // STATE RENDERING
  // ========================================================================

  it("renders participants with correct classes", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
        { id: "other-id", name: "Bob", estimate: null, po: true, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    const cards = wrapper.findAll(".card");
    expect(cards).toHaveLength(2);
    expect(cards[0].classes()).toContain("me");
    expect(cards[1].classes()).toContain("po");
  });

  it("shows correct estimate placeholders before reveal", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
        { id: "other-id", name: "Bob", estimate: "✓", po: false, connected: true },
        { id: "third-id", name: "Carol", estimate: "?", po: false, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    const estimates = wrapper.findAll(".estimate");
    expect(estimates[0].text()).toContain("✓"); // own estimate (number from server)
    expect(estimates[1].text()).toContain("✓"); // other estimated
    expect(estimates[2].text()).toContain("?"); // other not estimated
  });

  it("shows actual estimates after reveal", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: true,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
        { id: "other-id", name: "Bob", estimate: 8, po: false, connected: true },
      ],
      canReveal: true,
    });
    await flushPromises();

    const estimates = wrapper.findAll(".estimate");
    expect(estimates[0].text()).toContain("5");
    expect(estimates[1].text()).toContain("8");
  });

  it("ignores state updates for other lobbies", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-2",
      id: "lobby-2",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: null, po: false, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    expect((wrapper.vm as any).state).toBeNull();
  });

  it("syncs po state from server state", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: null, po: true, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    expect((wrapper.vm as any).po).toBe(true);
    expect((wrapper.vm as any).isPO).toBe(true);
  });

  // ========================================================================
  // ESTIMATE BUTTONS
  // ========================================================================

  it("shows estimate buttons for non-PO", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: null, po: false, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    const buttons = wrapper.findAll(".actions button");
    expect(buttons).toHaveLength(9);
  });

  it("hides estimate buttons for PO", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: null, po: true, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    expect(wrapper.find(".actions").exists()).toBe(false);
  });

  it("emits estimate when a button is clicked", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: null, po: false, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    const buttons = wrapper.findAll(".actions button");
    await buttons[3].trigger("click"); // value 3

    expect(mockSocket.emit).toHaveBeenCalledWith("estimate", "lobby-1", 3);
  });

  it("disables estimate buttons when revealed", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: true,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
      ],
      canReveal: true,
    });
    await flushPromises();

    const buttons = wrapper.findAll(".actions button");
    expect(buttons[0].attributes("disabled")).toBeDefined();
  });

  it("shows selected class on own estimate", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    const buttons = wrapper.findAll(".actions button");
    // Find button with value 5 (index 4)
    expect(buttons[4].classes()).toContain("selected");
  });

  // ========================================================================
  // REVEAL / RESET BUTTON
  // ========================================================================

  it("shows Reveal when not revealed and canReveal", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
      ],
      canReveal: true,
    });
    await flushPromises();

    const btn = wrapper.find(".reveal-btn");
    expect(btn.text()).toBe("Reveal");
    expect(btn.attributes("disabled")).toBeUndefined();
  });

  it("disables Reveal when not canReveal", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: null, po: false, connected: true },
      ],
      canReveal: false,
    });
    await flushPromises();

    const btn = wrapper.find(".reveal-btn");
    expect(btn.attributes("disabled")).toBeDefined();
  });

  it("shows Reset when revealed", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: true,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
      ],
      canReveal: true,
    });
    await flushPromises();

    const btn = wrapper.find(".reveal-btn");
    expect(btn.text()).toBe("Reset");
    expect(btn.attributes("disabled")).toBeUndefined();
  });

  it("emits reveal on click when not revealed", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
      ],
      canReveal: true,
    });
    await flushPromises();

    await wrapper.find(".reveal-btn").trigger("click");
    expect(mockSocket.emit).toHaveBeenCalledWith("reveal", "lobby-1");
  });

  it("emits reset on click when revealed", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: true,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
      ],
      canReveal: true,
    });
    await flushPromises();

    await wrapper.find(".reveal-btn").trigger("click");
    expect(mockSocket.emit).toHaveBeenCalledWith("reset", "lobby-1");
  });

  // ========================================================================
  // SETTINGS MODAL
  // ========================================================================

  it("opens settings modal when cog is clicked", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    expect(wrapper.find(".modal").exists()).toBe(false);

    await wrapper.find(".icon-btn").trigger("click");
    expect(wrapper.find(".modal").exists()).toBe(true);
  });

  it("closes settings modal when clicking outside", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    (wrapper.vm as any).showSettings = true;
    await flushPromises();

    await wrapper.find(".modal").trigger("click.self");
    expect(wrapper.find(".modal").exists()).toBe(false);
  });

  it("persists name to localStorage and emits setName", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    (wrapper.vm as any).name = "NewName";
    (wrapper.vm as any).updateName();

    expect(localStorageData["qp-name"]).toBe("NewName");
    expect(mockSocket.emit).toHaveBeenCalledWith("setName", "lobby-1", "NewName");
  });

  it("emits setPO when PO checkbox changes", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    (wrapper.vm as any).po = true;
    (wrapper.vm as any).updatePO();

    expect(mockSocket.emit).toHaveBeenCalledWith("setPO", "lobby-1", true);
  });

  // ========================================================================
  // RATE-LIMIT BANNER
  // ========================================================================

  it("displays rate-limit banner on rate-limited event", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.trigger("rate-limited", { event: "estimate", retryAfter: 5 });
    await flushPromises();

    expect(wrapper.find(".rate-limit-banner").exists()).toBe(true);
    expect(wrapper.find(".rate-limit-banner").text()).toContain("estimate");
  });

  it("clears rate-limit banner after retryAfter", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.trigger("rate-limited", { event: "estimate", retryAfter: 1 });
    await flushPromises();
    expect(wrapper.find(".rate-limit-banner").exists()).toBe(true);

    await new Promise((r) => setTimeout(r, 1100));
    await flushPromises();
    expect(wrapper.find(".rate-limit-banner").exists()).toBe(false);
  });

  // ========================================================================
  // LIFECYCLE
  // ========================================================================

  it("emits heartbeat every 5 seconds", async () => {
    const appOptions = await loadAppOptions();
    mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    // Wait for one heartbeat interval
    await new Promise((r) => setTimeout(r, 5100));
    expect(mockSocket.emit).toHaveBeenCalledWith("heartbeat");
  });

  it("clears heartbeat interval on unmount", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    wrapper.unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  // ========================================================================
  // DISCONNECT HANDLING
  // ========================================================================

  it("does not show reconnecting banner immediately on disconnect", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.connected = false;
    mockSocket.trigger("disconnect");
    await flushPromises();

    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);
    expect((wrapper.vm as any).disconnected).toBe(false);
  });

  it("shows reconnecting banner after 5 seconds of being disconnected", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.connected = false;
    mockSocket.trigger("disconnect");
    await flushPromises();

    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);

    await new Promise((r) => setTimeout(r, 5100));
    await flushPromises();

    expect(wrapper.find(".reconnecting-banner").exists()).toBe(true);
    expect(wrapper.find(".reconnecting-banner").text()).toContain("in 5s");
    expect((wrapper.vm as any).disconnected).toBe(true);
    wrapper.unmount();
  });

  it("counts down to the next automatic reconnect attempt", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    const connectSpy = vi.fn();
    mockSocket.connect = connectSpy;

    window.dispatchEvent(new Event("offline"));
    await flushPromises();
    expect(wrapper.find(".reconnecting-banner").text()).toContain("in 5s");

    await new Promise((r) => setTimeout(r, 1100));
    await flushPromises();
    expect(wrapper.find(".reconnecting-banner").text()).toContain("in 4s");

    await new Promise((r) => setTimeout(r, 4100));
    await flushPromises();
    expect(connectSpy).toHaveBeenCalled();
    expect(wrapper.find(".reconnecting-banner").text()).toContain("in 5s");

    wrapper.unmount();
  });

  it("cancels pending disconnect banner when socket reconnects", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.connected = false;
    mockSocket.trigger("disconnect");
    await flushPromises();

    // Reconnect before the 5s timer fires
    mockSocket.connected = true;
    mockSocket.trigger("connect");
    await flushPromises();

    await new Promise((r) => setTimeout(r, 5100));
    await flushPromises();

    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);
  });

  it("banner has no Reconnect button — auto-reconnect only", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    window.dispatchEvent(new Event("offline"));
    await flushPromises();

    const banner = wrapper.find(".reconnecting-banner");
    expect(banner.exists()).toBe(true);
    expect(banner.find("button").exists()).toBe(false);
    expect(banner.text()).toContain("offline");
    expect(banner.text()).toContain("Retrying");
    expect(banner.text()).toContain("in 5s");
    wrapper.unmount();
  });

  it("rejoins the lobby when the socket reconnects after a disconnect", async () => {
    const appOptions = await loadAppOptions();
    mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    (mockSocket.emit as ReturnType<typeof vi.fn>).mockClear();

    mockSocket.connected = false;
    mockSocket.trigger("disconnect");
    await flushPromises();

    mockSocket.connected = true;
    mockSocket.trigger("connect");
    await flushPromises();

    expect(mockSocket.emit).toHaveBeenCalledWith(
      "join",
      "lobby-1",
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      expect.any(Function),
    );
  });

  it("renders ghost participants with a ghost class", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.trigger("state", {
      lobbyId: "lobby-1",
      id: "lobby-1",
      revealed: false,
      participants: [
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false, connected: true },
        { id: "other-id", name: "Bob", estimate: null, po: false, connected: false },
      ],
      canReveal: false,
    });
    await flushPromises();

    const cards = wrapper.findAll(".card");
    expect(cards[0].classes()).not.toContain("ghost");
    expect(cards[1].classes()).toContain("ghost");
  });

  it("shows reconnecting banner immediately when the browser fires the offline event", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);
    expect((wrapper.vm as any).disconnected).toBe(false);

    window.dispatchEvent(new Event("offline"));
    await flushPromises();

    expect(wrapper.find(".reconnecting-banner").exists()).toBe(true);
    expect(wrapper.find(".reconnecting-banner").text()).toContain("in 5s");
    expect((wrapper.vm as any).disconnected).toBe(true);
    wrapper.unmount();
  });

  it("offline event cancels the pending 5s socket-disconnect timer", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    mockSocket.connected = false;
    mockSocket.trigger("disconnect");
    await flushPromises();

    // Offline event should show the banner right away, not after 5s
    window.dispatchEvent(new Event("offline"));
    await flushPromises();
    expect(wrapper.find(".reconnecting-banner").exists()).toBe(true);

    // Reconnect before 5s elapses
    mockSocket.connected = true;
    mockSocket.trigger("connect");
    await flushPromises();
    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);

    // Wait past the 5s threshold - the (now cleared) timer must NOT fire
    await new Promise((r) => setTimeout(r, 5100));
    await flushPromises();
    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);
  });

  it("proactively reconnects the socket when the browser fires the online event", async () => {
    const appOptions = await loadAppOptions();
    mount(appOptions);
    await flushPromises();

    const connectSpy = vi.fn();
    mockSocket.connect = connectSpy;

    window.dispatchEvent(new Event("online"));
    expect(connectSpy).toHaveBeenCalled();
  });

  it("removes the offline/online listeners on unmount", async () => {
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    const removeSpy = vi.spyOn(window, "removeEventListener");
    wrapper.unmount();
    const events = removeSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("offline");
    expect(events).toContain("online");
    removeSpy.mockRestore();
  });

  // ------------------------------------------------------------------------
  // Stale-transport / countdown hardening
  // ------------------------------------------------------------------------

  it("offline forces socket.disconnect() so emits don't enqueue on a stale transport", async () => {
    vi.useFakeTimers();
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    const disconnectSpy = mockSocket.disconnect as ReturnType<typeof vi.fn>;
    disconnectSpy.mockClear();

    window.dispatchEvent(new Event("offline"));
    await flushPromises();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("online calls socket.connect() unconditionally, even when the local flag still says connected", async () => {
    const appOptions = await loadAppOptions();
    mount(appOptions);
    await flushPromises();

    mockSocket.connected = true;
    const connectSpy = vi.fn();
    mockSocket.connect = connectSpy;

    window.dispatchEvent(new Event("online"));
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("countdown is cleared on successful connect — no second auto-retry cycle", async () => {
    vi.useFakeTimers();
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    const connectSpy = vi.fn();
    mockSocket.connect = connectSpy;

    window.dispatchEvent(new Event("offline"));
    await flushPromises();

    // Tick halfway through the 5s window
    vi.advanceTimersByTime(3_000);
    await flushPromises();

    // Real socket recovers before the next auto-retry
    mockSocket.connected = true;
    mockSocket.trigger("connect");
    await flushPromises();

    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);

    // 7s after the recovery — there should be no second cycle.
    vi.advanceTimersByTime(7_000);
    await flushPromises();
    expect(connectSpy).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("repeated offline events do not stack reconnect intervals", async () => {
    vi.useFakeTimers();
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    const connectSpy = vi.fn();
    mockSocket.connect = connectSpy;

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("offline"));
    await flushPromises();

    // 5.5s: the first interval has fired exactly once, the duplicate
    // dispatches must not have queued more.
    vi.advanceTimersByTime(5_500);
    await flushPromises();

    expect(connectSpy).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("synthetic disconnect while already reconnecting does not start a second 5s timer", async () => {
    vi.useFakeTimers();
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    // Force the app into the reconnecting state via offline
    window.dispatchEvent(new Event("offline"));
    await flushPromises();
    expect((wrapper.vm as any).disconnected).toBe(true);

    // Now a synthetic disconnect from the transport must be ignored —
    // the existing 5s socket-disconnect timer is guarded by the
    // `if (this.disconnected) return;` early-out. The `disconnectTimer`
    // field must stay null so we know no new setTimeout was queued.
    mockSocket.connected = false;
    mockSocket.trigger("disconnect");
    await flushPromises();
    expect((wrapper.vm as any).disconnectTimer).toBeNull();

    wrapper.unmount();
  });

  it("page is quiet at load: no banner, no countdown, no auto-reconnect attempts", async () => {
    vi.useFakeTimers();
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);
    expect((wrapper.vm as any).disconnected).toBe(false);
    expect((wrapper.vm as any).reconnectCountdown).toBe(0);

    const connectSpy = mockSocket.connect as ReturnType<typeof vi.fn>;
    connectSpy.mockClear();
    vi.advanceTimersByTime(10_000);
    await flushPromises();
    expect(connectSpy).not.toHaveBeenCalled();
    expect(wrapper.find(".reconnecting-banner").exists()).toBe(false);

    wrapper.unmount();
  });

  it("different mount gets a different per-tab sessionId but the same persistent userId", async () => {
    const appOptions = await loadAppOptions();
    const wrapper1 = mount(appOptions);
    await flushPromises();
    const userId1 = localStorageData["qp-user-id"];
    const sessionId1 = sessionStorageData["qp-session-id"];

    // Capture the join payload emitted from the first mount.
    const joinCallsAfterFirst = (mockSocket.emit.mock.calls as unknown[][]).filter(
      (call) => call[0] === "join",
    );
    expect(joinCallsAfterFirst).toHaveLength(1);
    const firstJoin = joinCallsAfterFirst[0];
    const firstJoinUserId = firstJoin[2] as string;
    const firstJoinSessionId = firstJoin[3] as string;
    expect(firstJoinUserId).toBe(userId1);

    wrapper1.unmount();

    // Wipe sessionStorage so the second mount generates a fresh sessionId.
    sessionStorageData = {};

    const wrapper2 = mount(appOptions);
    await flushPromises();
    expect(localStorageData["qp-user-id"]).toBe(userId1); // persistent
    expect(sessionStorageData["qp-session-id"]).not.toBe(sessionId1); // new per-tab

    const joinCallsAfterSecond = (mockSocket.emit.mock.calls as unknown[][]).filter(
      (call) => call[0] === "join",
    );
    expect(joinCallsAfterSecond).toHaveLength(2);
    const secondJoin = joinCallsAfterSecond[1];
    const secondJoinUserId = secondJoin[2] as string;
    const secondJoinSessionId = secondJoin[3] as string;
    expect(secondJoinUserId).toBe(firstJoinUserId);
    expect(secondJoinSessionId).not.toBe(firstJoinSessionId);

    wrapper2.unmount();
  });

  it("banner copy is exactly 'You are offline. Retrying to reconnect in 4s…' after one tick", async () => {
    vi.useFakeTimers();
    const appOptions = await loadAppOptions();
    const wrapper = mount(appOptions);
    await flushPromises();

    mockSocket.triggerCallback("join", "lobby-1");
    await flushPromises();

    window.dispatchEvent(new Event("offline"));
    await flushPromises();
    expect(wrapper.find(".reconnecting-banner").text()).toBe(
      "You are offline. Retrying to reconnect in 5s…",
    );

    vi.advanceTimersByTime(1_100);
    await flushPromises();
    expect(wrapper.find(".reconnecting-banner").text()).toBe(
      "You are offline. Retrying to reconnect in 4s…",
    );

    wrapper.unmount();
  });
});
