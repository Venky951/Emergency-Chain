/* Citizen presentation only. Canonical statuses come from the existing server APIs. */
(function () {
  "use strict";

  const COPY = Object.freeze({
    TRIGGERED: ["Emergency sent", "The server has recorded your emergency. You can now find nearby responders."],
    SEARCHING_FOR_HELP: ["Searching for help", "Your emergency is open for responder acceptance. No responder is assigned yet."],
    RESPONDER_ASSIGNED: ["Responder assigned", "A responder has accepted your emergency. Await their next update."],
    RESPONDER_ON_WAY: ["Responder on the way", "Your assigned responder has confirmed they are on the way."],
    HELP_REACHED: ["Help reached", "Your responder has reported arrival. Mark resolved when your emergency is over."],
    RESOLVED: ["Resolved", "This emergency is resolved. You can start a new SOS if needed."],
    CANCELLED: ["Cancelled", "This emergency was cancelled. This does not mean help reached you."],
  });
  const CANCELLABLE = ["TRIGGERED", "SEARCHING_FOR_HELP", "RESPONDER_ASSIGNED", "RESPONDER_ON_WAY"];
  const SEARCHABLE = ["TRIGGERED", "SEARCHING_FOR_HELP"];
  const terminal = (status) => status === "RESOLVED" || status === "CANCELLED";
  const validId = (id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id);
  const validRequestId = (id) => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);

  window.EC.createEmergencyWorkflow = function ({ socket, requestLocation, onEmergencyId } = {}) {
    const root = document.getElementById("emergencyWorkflow");
    if (!root) return null;
    const el = (id) => document.getElementById(id);
    const creationButtons = [...root.querySelectorAll("[data-sos-level]")];
    const steps = [...root.querySelectorAll("[data-emergency-step]")];
    const storageKey = `emergencychain:workflow:${root.dataset.userId}`;
    let emergencyId = null;
    let requestId = null;
    let status = null;
    let observed = new Set();
    const retiredEmergencyIds = new Set();
    let lastUpdated = 0;
    let revision = 0;
    let booting = true;
    let submitting = false;
    let submissionSequence = 0;
    let action = null;
    let transport = null;
    let location = null;
    let locationPending = true;
    let recoveryPromise = null;
    let initialized = false;
    let storageAvailable = true;

    function visible(element, show) {
      element.classList.toggle("hidden", !show);
    }

    function setText(id, value) {
      // Repeated location/transport updates must not re-announce unchanged live text.
      if (el(id).textContent !== value) el(id).textContent = value;
    }

    function persist() {
      try {
        if ((!emergencyId && !requestId) || terminal(status)) {
          sessionStorage.removeItem(storageKey);
        } else {
          // Only identifiers: never copy coordinates, descriptions, or history here.
          sessionStorage.setItem(storageKey, JSON.stringify({ emergencyId, requestId }));
        }
      } catch {
        storageAvailable = false;
      }
    }

    function feedback(message) {
      setText("emergencyFeedback", message);
    }

    function focusStatus() {
      el("statusTextTop").focus({ preventScroll: true });
    }

    function render() {
      const active = !!emergencyId && !terminal(status);
      const locked = booting || submitting || !!action || !!requestId || active || !!transport;
      creationButtons.forEach((button) => { button.disabled = locked || !location; });
      el("reason").disabled = locked;
      el("msg").disabled = locked;
      el("emergencyCreationControls").setAttribute("aria-busy", String(booting || submitting));
      el("retryLocationButton").disabled = locationPending;
      el("emergencyControlsHint").textContent = booting
        ? "Checking request status before enabling SOS."
        : locked
          ? "A request is in progress. New SOS creation is disabled to avoid duplicates."
          : !location
            ? "Location is required before you can send an SOS. Use Retry location after allowing access."
            : "Choose one SOS option. Each send button starts a request immediately.";

      let title = "Ready for SOS";
      let detail = "Choose the emergency option you need below.";
      if (status) [title, detail] = COPY[status];
      else if (booting) {
        title = "Checking for an existing request…";
        detail = "Please wait while this tab checks its saved request.";
      } else if ((submitting && !transport) || transport === "syncing") {
        title = "Submitting SOS…";
        detail = "Waiting for server confirmation. Please do not send another request.";
      } else if (transport === "queued") {
        title = navigator.onLine === false ? "Queued offline — not yet sent to server" : "Request queued for retry";
        detail = "Server creation is not confirmed. The existing offline queue will retry this same request.";
      } else if (transport === "auth-required") {
        title = "Login required to send SOS";
        detail = "Your request is still queued; server creation is not confirmed.";
      } else if (transport === "conflict") {
        title = "An active emergency already exists";
        detail = "The server did not provide its ID. Return to the tab that started it to check or end that emergency.";
      } else if (transport === "unknown" || emergencyId) {
        title = "Request status unavailable";
        detail = "We cannot confirm this request yet. New SOS creation remains disabled. Try Refresh status or return to the original tab.";
      }
      setText("statusTextTop", title);
      setText("statusTextLive", detail);
      root.dataset.emergencyStatus = status || "";
      visible(el("emergencyLoginLink"), transport === "auth-required");
      visible(el("searchRespondersButton"), SEARCHABLE.includes(status));
      visible(el("cancelEmergencyButton"), CANCELLABLE.includes(status));
      visible(el("resolveEmergencyButton"), status === "HELP_REACHED");
      visible(el("refreshEmergencyButton"), !!emergencyId || !!requestId || !!transport);
      ["searchRespondersButton", "cancelEmergencyButton", "resolveEmergencyButton"].forEach((id) => {
        el(id).disabled = !!action || booting;
      });
      el("refreshEmergencyButton").disabled = !!recoveryPromise || !!action || submitting;
      el("cancelEmergencyButton").textContent = action === "cancel" ? "Cancelling…" : "Cancel Emergency";
      el("resolveEmergencyButton").textContent = action === "resolve" ? "Resolving…" : "Mark resolved";
      el("searchRespondersButton").textContent = action === "search" ? "Searching responders…" : "Find Nearby Responders";
      visible(el("emergencyProgress"), !!status);
      steps.forEach((step) => {
        const name = step.dataset.emergencyStep;
        const current = name === status;
        const recorded = observed.has(name);
        step.dataset.stepState = current ? "current" : recorded ? "recorded" : "pending";
        if (current) step.setAttribute("aria-current", "step");
        else step.removeAttribute("aria-current");
        if (name === "CANCELLED") visible(step, status === "CANCELLED");
        step.querySelector("[data-step-label]").textContent = current
          ? (name === "CANCELLED" ? "— Cancelled; emergency ended" : "— Current status")
          : recorded ? "— Recorded" : "— Not recorded";
      });
    }

    function applyEmergency(emergency, { history, source } = {}) {
      const id = emergency?.id || emergency?._id || emergency?.emergencyId;
      const nextStatus = emergency?.status;
      if (!validId(id) || !Object.hasOwn(COPY, nextStatus)) return false;
      if (retiredEmergencyIds.has(id)) return false;
      if (source === "socket" && !emergencyId && (submitting || requestId) && terminal(nextStatus)) return false;
      if (emergencyId && id !== emergencyId && !terminal(status)) return false;
      const timestamp = Date.parse(emergency.updatedAt) || 0;
      if (id === emergencyId) {
        // Creation responses contain no timestamp and can follow a newer socket update.
        if (status && source === "creation") {
          // Idempotent replay can also contain a newer snapshot. History resolves
          // that ambiguity without inventing client-side lifecycle transitions.
          if (status !== nextStatus) recover();
          return true;
        }
        if (lastUpdated && timestamp && timestamp < lastUpdated) return false;
        if (terminal(status) && nextStatus !== status) return false;
      } else {
        observed = new Set();
        lastUpdated = 0;
      }
      emergencyId = id;
      status = nextStatus;
      revision += 1;
      lastUpdated = Math.max(lastUpdated, timestamp);
      (history || []).forEach((entry) => {
        if (Object.hasOwn(COPY, entry.toStatus)) observed.add(entry.toStatus);
      });
      observed.add(status);
      transport = null;
      if (terminal(status)) requestId = null;
      if (!SEARCHABLE.includes(status)) el("nearbyResponders").textContent = "";
      onEmergencyId?.(emergencyId);
      persist();
      render();
      return true;
    }

    function handleQueueStatus(detail) {
      if (!requestId || detail?.requestId !== requestId) return;
      if (detail.status === "synced") {
        const applied = applyEmergency(detail.emergency, { source: "creation" });
        if (applied) {
          requestId = null;
          transport = null;
          persist();
          feedback("SOS confirmed by the server.");
        } else {
          transport = "unknown";
          feedback("The queue has finished, but no emergency ID was returned. Server status cannot be recovered from this tab yet.");
        }
      } else if (detail.status === "failed") {
        requestId = null;
        transport = null;
        persist();
        feedback(status
          ? "The server already confirmed this emergency, but the queued submission reported a failure. Refresh status to check the latest update."
          : `SOS could not be sent. ${detail.error || "Please try again."}`);
      } else if (["queued", "syncing", "auth-required", "conflict"].includes(detail.status)) {
        // A confirmed server emergency takes precedence over transport feedback.
        if (!status) transport = detail.status;
        if (detail.status === "conflict") feedback(detail.error || "Another active emergency prevents this SOS.");
      }
      render();
    }

    async function submit(level) {
      if (booting || submitting || action || requestId || transport || (emergencyId && !terminal(status))) return;
      if (!location) {
        feedback("Location unavailable. Allow location access and use Retry location before sending SOS.");
        return;
      }
      const type = { 1: "GENERAL", 2: "SAFETY", 3: "CRITICAL" }[level];
      if (!type) return;
      // Lock synchronously, before IndexedDB, service worker, or network awaits.
      submitting = true;
      const submission = ++submissionSequence;
      revision += 1;
      if (emergencyId) retiredEmergencyIds.add(emergencyId);
      emergencyId = null;
      status = null;
      observed = new Set();
      lastUpdated = 0;
      onEmergencyId?.(null);
      feedback("Submitting your SOS. Waiting for server confirmation.");
      render();
      focusStatus();
      const description = Number(level) === 2
        ? `${el("reason").value}${el("msg").value.trim() ? `: ${el("msg").value.trim()}` : ""}`
        : Number(level) === 3 ? "Critical emergency" : "Emergency - Level 1";
      try {
        const result = await window.EC.createCanonicalEmergency({
          emergencyType: type, description, ...location,
          onRequestId(id) {
            requestId = id;
            persist();
            // The existing worker registration may still be pending; IndexedDB
            // has already saved this request, so offline feedback can be immediate.
            if (navigator.onLine === false) {
              transport = "queued";
              // The saved request ID keeps creation locked while worker readiness
              // is pending. Status refresh remains usable in the meantime.
              submitting = false;
            }
            render();
          },
        });
        handleQueueStatus({
          status: result.state, requestId: result.requestId,
          emergency: result.data?.emergency,
          error: result.data?.error || result.error?.message,
        });
      } catch {
        if (submission !== submissionSequence) return;
        if (requestId) {
          transport = "unknown";
          feedback("Your saved request could not be checked. Use Refresh status; do not submit another SOS yet.");
        } else {
          feedback("SOS could not be saved or sent. Please try again.");
        }
      } finally {
        if (submission === submissionSequence) {
          submitting = false;
          render();
          if (!storageAvailable) feedback("Keep this tab open: browser storage is unavailable, so reload recovery cannot be saved.");
        }
      }
    }

    async function requestJson(url, options) {
      const response = await fetch(url, {
        credentials: "same-origin", ...options,
        headers: { Accept: "application/json", ...options?.headers },
      });
      let data;
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok || !data.success) {
        const error = new Error(data.error || "The server could not confirm this action. Try again.");
        error.status = response.status;
        throw error;
      }
      return data;
    }

    async function recover() {
      if (recoveryPromise) return recoveryPromise;
      const startedRevision = revision;
      const id = emergencyId;
      const pendingId = requestId;
      recoveryPromise = (async () => {
        if (id) {
          try {
            const data = await requestJson(`/emergency/${id}/history`);
            if (revision !== startedRevision || emergencyId !== id) return;
            const history = Array.isArray(data.history) ? data.history : [];
            const latest = history[history.length - 1];
            if (!latest || !applyEmergency({ id, status: latest.toStatus, updatedAt: latest.createdAt }, { history, source: "history" })) {
              throw new Error("No confirmed emergency status was found in history.");
            }
          } catch (error) {
            if (revision === startedRevision && emergencyId === id) {
              if (error.status === 401 || error.status === 403 || error.status === 404) {
                // Remove persisted inaccessible IDs, but keep this view locked until navigation.
                try { sessionStorage.removeItem(storageKey); } catch { /* Storage unavailable. */ }
              }
              feedback(`Status refresh failed. ${error.message}`);
            }
          }
        } else if (pendingId) {
          try {
            const record = await window.EC.offlineDB.getCanonicalEmergency(pendingId);
            if (revision !== startedRevision || requestId !== pendingId) return;
            if (!record) {
              transport = "unknown";
              feedback("The saved queue record is no longer available. It may have synced while this tab was closed. Without an emergency ID this tab cannot confirm the outcome.");
            } else {
              handleQueueStatus({
                requestId: pendingId,
                status: record.status === "pending" ? "queued" : record.status,
                error: record.lastError,
              });
            }
          } catch {
            if (revision === startedRevision && requestId === pendingId) {
              transport = "unknown";
              feedback("The saved request could not be read. Keep this tab open and try Refresh status.");
            }
          }
        }
      })();
      render();
      try { await recoveryPromise; } finally { recoveryPromise = null; render(); }
    }

    async function updateStatus(nextStatus) {
      const data = await requestJson(`/emergency/${emergencyId}/status`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!applyEmergency(data.emergency, { source: "action" })) {
        // A newer socket update can legitimately supersede this response.
        await recover();
      }
    }

    async function endEmergency(kind) {
      const resolving = kind === "resolve";
      if (action || booting || !(resolving ? status === "HELP_REACHED" : CANCELLABLE.includes(status))) return;
      if (!window.confirm(resolving ? "Mark this emergency as resolved?" : "Cancel this emergency? This ends the active request.")) return;
      action = kind;
      feedback(resolving ? "Resolving emergency…" : "Cancelling emergency…");
      render();
      focusStatus();
      try {
        await updateStatus(resolving ? "RESOLVED" : "CANCELLED");
        feedback(status === (resolving ? "RESOLVED" : "CANCELLED")
          ? (resolving ? "Emergency resolved." : "Emergency cancelled.")
          : "The server status has changed. Review the current emergency status.");
      } catch (error) {
        await recover();
        feedback(`${resolving ? "Resolution" : "Cancellation"} failed. ${error.message}`);
      } finally { action = null; render(); }
    }

    async function searchNearbyResponders() {
      if (action || booting || !SEARCHABLE.includes(status)) return;
      action = "search";
      const id = emergencyId;
      feedback("Searching for nearby responders…");
      el("nearbyResponders").textContent = "Checking responder availability…";
      render();
      try {
        if (status === "TRIGGERED") await updateStatus("SEARCHING_FOR_HELP");
        if (emergencyId !== id || !SEARCHABLE.includes(status)) return;
        const data = await requestJson(`/api/emergency/${id}/nearby-responders`);
        if (emergencyId !== id || !SEARCHABLE.includes(status)) return;
        const responders = Array.isArray(data.responders) ? data.responders : [];
        el("nearbyResponders").textContent = "";
        if (!responders.length) {
          el("nearbyResponders").textContent = "No nearby responders found. Your emergency is still searching for help. You can search again.";
        } else {
          responders.forEach((responder) => {
            const row = document.createElement("p");
            row.className = "helper-copy";
            const distance = Number.isFinite(responder.distanceKm) ? ` · ${responder.distanceKm.toFixed(1)} km away` : "";
            row.textContent = `${responder.displayName || "Responder"} · ${responder.role || "Responder"}${distance}`;
            el("nearbyResponders").appendChild(row);
          });
        }
        feedback(responders.length ? "Nearby responders found. Assignment is confirmed only when a responder accepts." : "No nearby responders are currently available.");
      } catch (error) {
        if (emergencyId === id && SEARCHABLE.includes(status)) {
          el("nearbyResponders").textContent = "Responder search could not be completed. Please try again.";
          await recover();
          feedback(`Responder search failed. ${error.message}`);
        }
      } finally { action = null; render(); }
    }

    function setLocationPending() {
      locationPending = true;
      location = null;
      setText("sosLocationStatus", "Requesting location permission…");
      render();
    }

    function setLocation(value) {
      if (!Number.isFinite(value?.latitude) || !Number.isFinite(value?.longitude)) {
        setLocationUnavailable();
        return;
      }
      location = { latitude: value.latitude, longitude: value.longitude, accuracy: value.accuracy ?? null };
      locationPending = false;
      setText("sosLocationStatus", "Location available. These coordinates will be included when you send SOS.");
      render();
    }

    function setLocationUnavailable(error) {
      location = null;
      locationPending = false;
      setText("sosLocationStatus", error?.code === 1
        ? "Location permission denied. Allow location in your browser settings, then use Retry location."
        : "Location unavailable. Check your device location settings, then use Retry location.");
      render();
    }

    async function initialize() {
      if (initialized) return;
      initialized = true;
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");
        if (validId(saved?.emergencyId)) emergencyId = saved.emergencyId;
        if (validRequestId(saved?.requestId)) requestId = saved.requestId;
        onEmergencyId?.(emergencyId);
      } catch { storageAvailable = false; }
      if (requestId) transport = "unknown";
      render();
      await recover();
      booting = false;
      render();
    }

    creationButtons.forEach((button) => button.addEventListener("click", () => submit(Number(button.dataset.sosLevel))));
    el("cancelEmergencyButton").addEventListener("click", () => endEmergency("cancel"));
    el("resolveEmergencyButton").addEventListener("click", () => endEmergency("resolve"));
    el("searchRespondersButton").addEventListener("click", searchNearbyResponders);
    el("retryLocationButton").addEventListener("click", () => requestLocation?.());
    el("refreshEmergencyButton").addEventListener("click", async () => {
      feedback("Refreshing request status…");
      await recover();
      window.EC.refreshCanonicalEmergencyState();
    });
    document.querySelector('form[action="/logout"]')?.addEventListener("submit", () => {
      try { sessionStorage.removeItem(storageKey); } catch { /* Storage unavailable. */ }
    });
    window.addEventListener("canonical-emergency-status", (event) => handleQueueStatus(event.detail));
    navigator.serviceWorker?.addEventListener("message", (event) => {
      if (event.data?.type === "canonical-emergency-status") handleQueueStatus(event.data);
    });
    window.EC.registerEmergencyUpdateListener(socket, (data) => {
      if (applyEmergency(data, { source: "socket" })) feedback("Emergency status updated by the server.");
    });
    window.addEventListener("app-socket-connected", recover);
    window.addEventListener("app-online", () => { render(); recover(); });
    window.addEventListener("app-offline", render);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) recover(); });
    render();
    return {
      initialize, submit, recover, setLocation, setLocationPending, setLocationUnavailable,
      setLocationNote(message) { setText("sosLocationStatus", message); },
      cancelEmergency() { return endEmergency("cancel"); },
      resolveEmergency() { return endEmergency("resolve"); },
      searchNearbyResponders,
    };
  };
})();
