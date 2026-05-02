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

  it("mounts and emits join on mounted", async () => {
    const appOptions = await loadAppOptions();
    mount(appOptions);
    await flushPromises();
    expect(mockSocket.emit).toHaveBeenCalledWith("join", "", expect.any(Function));
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
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false },
        { id: "other-id", name: "Bob", estimate: null, po: true },
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
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false },
        { id: "other-id", name: "Bob", estimate: "✓", po: false },
        { id: "third-id", name: "Carol", estimate: "?", po: false },
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
        { id: "mock-socket-id", name: "Alice", estimate: 5, po: false },
        { id: "other-id", name: "Bob", estimate: 8, po: false },
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: null, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: null, po: true }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: null, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: null, po: true }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: null, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: 5, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: 5, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: 5, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: null, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: 5, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: 5, po: false }],
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
      participants: [{ id: "mock-socket-id", name: "Alice", estimate: 5, po: false }],
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
});
