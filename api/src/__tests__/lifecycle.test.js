const { canTransition } = require("../lib/lifecycle");

describe("canTransition", () => {
  it("allows the documented happy path", () => {
    expect(canTransition("REQUESTED", "MATCHED")).toBe(true);
    expect(canTransition("MATCHED", "DRIVER_ARRIVED")).toBe(true);
    expect(canTransition("DRIVER_ARRIVED", "STARTED")).toBe(true);
    expect(canTransition("STARTED", "COMPLETED")).toBe(true);
  });

  it("allows cancellation before STARTED", () => {
    expect(canTransition("REQUESTED", "CANCELLED")).toBe(true);
    expect(canTransition("MATCHED", "CANCELLED")).toBe(true);
    expect(canTransition("DRIVER_ARRIVED", "CANCELLED")).toBe(true);
  });

  it("rejects cancellation after STARTED", () => {
    expect(canTransition("STARTED", "CANCELLED")).toBe(false);
  });

  it("rejects skipping states (REQUESTED straight to STARTED)", () => {
    expect(canTransition("REQUESTED", "STARTED")).toBe(false);
  });

  it("rejects any transition out of a terminal state", () => {
    expect(canTransition("COMPLETED", "REQUESTED")).toBe(false);
    expect(canTransition("CANCELLED", "REQUESTED")).toBe(false);
  });
});
