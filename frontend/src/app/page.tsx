"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import autoTable from "jspdf-autotable";
import jsPDF from "jspdf";
import { Toaster, toast } from "sonner";

import CommandMap from "@/components/CommandMap";
import {
  applyScenario,
  type DroneState,
  type FaultState,
  type OperatorState,
  type SimulatorStatus,
  cancelDroneWaypoints,
  getSimulatorStatus,
  queueDroneWaypoints,
  releaseDroneControl,
  resetLiveData,
  returnDroneToOrigin,
  seedSampleTeam,
  setDroneMode,
  setManualIdleTimeout,
  startSimulator,
  stopSimulator,
  subscribeToMonitoringData,
  navigateDrone,
  updateFaultStatus,
} from "@/lib/monitoring";

function prettyPercent(value: number): string {
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function playAlarmSound(level: "medium" | "high"): void {
  if (typeof window === "undefined" || !("AudioContext" in window)) {
    return;
  }

  const audioContext = new window.AudioContext();
  const pulseCount = level === "high" ? 6 : 3;
  const pulseGap = level === "high" ? 0.12 : 0.16;
  const baseFrequency = level === "high" ? 960 : 760;

  for (let index = 0; index < pulseCount; index += 1) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const startAt = audioContext.currentTime + index * pulseGap;
    const duration = 0.07;
    const currentFrequency = index % 2 === 0 ? baseFrequency : baseFrequency * 0.72;

    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(currentFrequency, startAt);

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(level === "high" ? 0.07 : 0.045, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration);
  }

  const totalDuration = pulseCount * pulseGap + 0.18;
  window.setTimeout(() => {
    audioContext.close().catch(() => {
      // No-op.
    });
  }, totalDuration * 1000);
}

type WidgetId = "title" | "metrics" | "reports" | "stream" | "manual" | "faults" | "table" | "error";
type WidgetPosition = { x: number; y: number };

const DEFAULT_POSITIONS: Record<WidgetId, WidgetPosition> = {
  title: { x: 24, y: 24 },
  metrics: { x: 620, y: 24 },
  reports: { x: 970, y: 24 },
  stream: { x: 24, y: 210 },
  manual: { x: 24, y: 430 },
  faults: { x: 1020, y: 210 },
  table: { x: 430, y: 430 },
  error: { x: 430, y: 24 },
};

const SNAP_DISTANCE = 28;
const SNAP_MARGIN = 18;
const TELEMETRY_PAGE_SIZE = 5;
const FAULT_FEED_PAGE_SIZE = 5;
const WORKFLOW_PAGE_SIZE = 6;

type AlertPulse = "none" | "medium" | "high";
type EdgeEffectLevel = "subtle" | "strong";

type DraggableWidgetProps = {
  id: WidgetId;
  title: string;
  className?: string;
  onStartDrag: (id: WidgetId, event: React.PointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
};

function DraggableWidget({
  id,
  title,
  className,
  onStartDrag,
  children,
}: DraggableWidgetProps) {
  return (
    <article
      data-widget-id={id}
      className={`glass widget-shell ${className ?? ""}`.trim()}
    >
      <div className="widget-handle" onPointerDown={(event) => onStartDrag(id, event)}>
        <span>{title}</span>
        <span className="widget-grip" aria-hidden="true">::::</span>
      </div>
      {children}
    </article>
  );
}

export default function Home() {
  const [drones, setDrones] = useState<DroneState[]>([]);
  const [faults, setFaults] = useState<FaultState[]>([]);
  const [operators, setOperators] = useState<OperatorState[]>([]);
  const [error, setError] = useState<string>("");
  const [updatingFaultId, setUpdatingFaultId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<WidgetId, WidgetPosition>>(DEFAULT_POSITIONS);
  const [draggingId, setDraggingId] = useState<WidgetId | null>(null);
  const [telemetryPage, setTelemetryPage] = useState(1);
  const [faultFeedPage, setFaultFeedPage] = useState(1);
  const [workflowPage, setWorkflowPage] = useState(1);
  const [assigneeDrafts, setAssigneeDrafts] = useState<Record<string, string>>({});
  const [simStatus, setSimStatus] = useState<SimulatorStatus | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);
  const [navigatingDroneId, setNavigatingDroneId] = useState<string | null>(null);
  const [modeUpdatingDroneId, setModeUpdatingDroneId] = useState<string | null>(null);
  const [selectedDroneId, setSelectedDroneId] = useState<string | null>(null);
  const [manualStepMeters, setManualStepMeters] = useState(35);
  const [waypointArmed, setWaypointArmed] = useState(false);
  const [timeoutBusy, setTimeoutBusy] = useState(false);
  const [manualIdleTimeoutDraft, setManualIdleTimeoutDraft] = useState<number>(90);
  const [manualOperator, setManualOperator] = useState<string>("Ops Desk 1");
  const [pendingWaypoints, setPendingWaypoints] = useState<Array<{ lat: number; lng: number }>>([]);
  const [reportStartDate, setReportStartDate] = useState<string>("");
  const [reportEndDate, setReportEndDate] = useState<string>("");
  const [alertPulse, setAlertPulse] = useState<AlertPulse>("none");
  const [edgeEffectLevel, setEdgeEffectLevel] = useState<EdgeEffectLevel>("subtle");
  const knownFaultsRef = useRef<Set<string>>(new Set());
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ pointerOffsetX: number; pointerOffsetY: number } | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToMonitoringData(setDrones, setFaults, setOperators, setError);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    getSimulatorStatus()
      .then((status) => setSimStatus(status))
      .catch(() => {
        // The dashboard can still run even if backend simulator controls are unavailable.
      });
  }, []);

  useEffect(() => {
    if (simStatus?.manual_idle_timeout_seconds) {
      setManualIdleTimeoutDraft(simStatus.manual_idle_timeout_seconds);
    }
  }, [simStatus?.manual_idle_timeout_seconds]);

  useEffect(() => {
    if (faults.length === 0) return;

    if (knownFaultsRef.current.size === 0) {
      faults.forEach((fault) => knownFaultsRef.current.add(fault.id));
      return;
    }

    faults.forEach((fault) => {
      if (!knownFaultsRef.current.has(fault.id)) {
        knownFaultsRef.current.add(fault.id);
        const place = fault.locationName ?? `${fault.lat.toFixed(4)}, ${fault.lng.toFixed(4)}`;
        toast.warning("New fault detected", {
          description: (
            <span className="fault-toast-description">
              {`${fault.faultType} (${fault.severity}) near ${place}`}
            </span>
          ),
        });

        const nextPulse = fault.severity === "critical" || fault.severity === "high" ? "high" : "medium";
        setAlertPulse(nextPulse);
        window.setTimeout(() => setAlertPulse("none"), 1400);

        playAlarmSound(nextPulse);
      }
    });
  }, [faults]);

  const activeDrones = useMemo(
    () => drones.filter((drone) => drone.status === "active").length,
    [drones],
  );
  const criticalFaults = useMemo(
    () => faults.filter((fault) => fault.severity === "critical" || fault.severity === "high").length,
    [faults],
  );

  const unresolvedFaults = useMemo(
    () => faults.filter((fault) => fault.status === "unresolved").length,
    [faults],
  );

  const storyCards = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayIncidents = faults.filter((fault) => {
      if (!fault.detectedAt) return false;
      const value = new Date(fault.detectedAt).getTime();
      return !Number.isNaN(value) && value >= startOfDay;
    });

    const resolvedCount = faults.filter((fault) => fault.status === "resolved").length;

    const responseMinutes = faults
      .filter((fault) => fault.detectedAt && fault.resolvedAt)
      .map((fault) => {
        const detected = new Date(fault.detectedAt as string).getTime();
        const resolved = new Date(fault.resolvedAt as string).getTime();
        if (Number.isNaN(detected) || Number.isNaN(resolved) || resolved < detected) {
          return null;
        }
        return (resolved - detected) / 60000;
      })
      .filter((value): value is number => value !== null);

    const avgResponse = responseMinutes.length > 0
      ? `${(responseMinutes.reduce((acc, value) => acc + value, 0) / responseMinutes.length).toFixed(1)} min`
      : "N/A";

    return {
      todayIncidents: dayIncidents.length,
      resolvedCount,
      avgResponse,
      activeTeam: operators.filter((operator) => operator.availability === "online").length,
    };
  }, [faults, operators]);

  const telemetryTotalPages = Math.max(1, Math.ceil(drones.length / TELEMETRY_PAGE_SIZE));
  const faultFeedTotalPages = Math.max(1, Math.ceil(faults.length / FAULT_FEED_PAGE_SIZE));
  const workflowTotalPages = Math.max(1, Math.ceil(faults.length / WORKFLOW_PAGE_SIZE));

  const telemetryItems = useMemo(() => {
    const start = (telemetryPage - 1) * TELEMETRY_PAGE_SIZE;
    return drones.slice(start, start + TELEMETRY_PAGE_SIZE);
  }, [drones, telemetryPage]);

  const selectedDrone = useMemo(
    () => drones.find((drone) => drone.id === selectedDroneId) ?? null,
    [drones, selectedDroneId],
  );

  useEffect(() => {
    if (selectedDroneId && !selectedDrone) {
      setSelectedDroneId(null);
    }
  }, [selectedDrone, selectedDroneId]);

  useEffect(() => {
    if (!selectedDrone || selectedDrone.controlMode !== "manual") {
      setWaypointArmed(false);
      setPendingWaypoints([]);
    }
  }, [selectedDrone]);

  const selectedDroneLockedByOther = useMemo(() => {
    if (!selectedDrone || !selectedDrone.controlOwner) {
      return false;
    }
    return selectedDrone.controlOwner.toLowerCase() !== manualOperator.toLowerCase();
  }, [manualOperator, selectedDrone]);

  const waypointPreviewPath = useMemo(() => {
    if (!selectedDrone || pendingWaypoints.length === 0) {
      return [];
    }
    return [{ lat: selectedDrone.lat, lng: selectedDrone.lng }, ...pendingWaypoints];
  }, [pendingWaypoints, selectedDrone]);

  const faultFeedItems = useMemo(() => {
    const start = (faultFeedPage - 1) * FAULT_FEED_PAGE_SIZE;
    return faults.slice(start, start + FAULT_FEED_PAGE_SIZE);
  }, [faults, faultFeedPage]);

  const workflowItems = useMemo(() => {
    const start = (workflowPage - 1) * WORKFLOW_PAGE_SIZE;
    return faults.slice(start, start + WORKFLOW_PAGE_SIZE);
  }, [faults, workflowPage]);

  useEffect(() => {
    if (telemetryPage > telemetryTotalPages) {
      setTelemetryPage(telemetryTotalPages);
    }
  }, [telemetryPage, telemetryTotalPages]);

  useEffect(() => {
    if (faultFeedPage > faultFeedTotalPages) {
      setFaultFeedPage(faultFeedTotalPages);
    }
  }, [faultFeedPage, faultFeedTotalPages]);

  useEffect(() => {
    if (workflowPage > workflowTotalPages) {
      setWorkflowPage(workflowTotalPages);
    }
  }, [workflowPage, workflowTotalPages]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    (Object.keys(positions) as WidgetId[]).forEach((id) => {
      const target = overlay.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);
      const pos = positions[id];
      if (!target || !pos) return;
      target.style.left = `${pos.x}px`;
      target.style.top = `${pos.y}px`;
    });
  }, [positions]);

  useEffect(() => {
    if (!draggingId) return;
    const activeDraggingId = draggingId;

    function onPointerMove(event: PointerEvent): void {
      const overlay = overlayRef.current;
      const dragState = dragStateRef.current;
      if (!overlay || !dragState) return;

      const target = overlay.querySelector<HTMLElement>(`[data-widget-id="${activeDraggingId}"]`);
      if (!target) return;

      const bounds = overlay.getBoundingClientRect();
      const targetWidth = target.offsetWidth;
      const targetHeight = target.offsetHeight;

      let nextX = event.clientX - bounds.left - dragState.pointerOffsetX;
      let nextY = event.clientY - bounds.top - dragState.pointerOffsetY;

      const maxX = Math.max(SNAP_MARGIN, bounds.width - targetWidth - SNAP_MARGIN);
      const maxY = Math.max(SNAP_MARGIN, bounds.height - targetHeight - SNAP_MARGIN);

      nextX = Math.max(SNAP_MARGIN, Math.min(maxX, nextX));
      nextY = Math.max(SNAP_MARGIN, Math.min(maxY, nextY));

      setPositions((prev) => ({
        ...prev,
        [activeDraggingId]: { x: nextX, y: nextY },
      }));
    }

    function onPointerUp(): void {
      const overlay = overlayRef.current;
      if (!overlay) return;

      const target = overlay.querySelector<HTMLElement>(`[data-widget-id="${activeDraggingId}"]`);
      if (!target) {
        setDraggingId(null);
        dragStateRef.current = null;
        return;
      }

      const bounds = overlay.getBoundingClientRect();
      const targetWidth = target.offsetWidth;
      const targetHeight = target.offsetHeight;

      setPositions((prev) => {
        const current = prev[activeDraggingId];
        let snappedX = current.x;
        let snappedY = current.y;

        const rightGap = bounds.width - (current.x + targetWidth);
        const bottomGap = bounds.height - (current.y + targetHeight);

        if (current.x <= SNAP_MARGIN + SNAP_DISTANCE) snappedX = SNAP_MARGIN;
        if (rightGap <= SNAP_MARGIN + SNAP_DISTANCE) snappedX = Math.max(SNAP_MARGIN, bounds.width - targetWidth - SNAP_MARGIN);
        if (current.y <= SNAP_MARGIN + SNAP_DISTANCE) snappedY = SNAP_MARGIN;
        if (bottomGap <= SNAP_MARGIN + SNAP_DISTANCE) snappedY = Math.max(SNAP_MARGIN, bounds.height - targetHeight - SNAP_MARGIN);

        return {
          ...prev,
          [activeDraggingId]: { x: snappedX, y: snappedY },
        };
      });

      setDraggingId(null);
      dragStateRef.current = null;
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [draggingId]);

  function startDrag(widgetId: WidgetId, event: React.PointerEvent<HTMLDivElement>): void {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const target = overlay.querySelector<HTMLElement>(`[data-widget-id="${widgetId}"]`);
    if (!target) return;

    const targetBounds = target.getBoundingClientRect();
    dragStateRef.current = {
      pointerOffsetX: event.clientX - targetBounds.left,
      pointerOffsetY: event.clientY - targetBounds.top,
    };
    setDraggingId(widgetId);
  }

  const operatorNames = useMemo(() => {
    if (operators.length === 0) {
      return ["Ops Desk 1"];
    }
    return operators.map((operator) => operator.name);
  }, [operators]);

  useEffect(() => {
    if (!operatorNames.includes(manualOperator)) {
      setManualOperator(operatorNames[0]);
    }
  }, [manualOperator, operatorNames]);

  const onlineOperators = useMemo(
    () => operators.filter((operator) => operator.availability === "online"),
    [operators],
  );

  const assignableOperators = useMemo(
    () => (onlineOperators.length > 0 ? onlineOperators : operators),
    [onlineOperators, operators],
  );

  function getAutoAssignee(): string {
    const availableNames = assignableOperators.length > 0 ? assignableOperators.map((item) => item.name) : operatorNames;

    const load = availableNames.reduce<Record<string, number>>((acc, operator) => {
      acc[operator] = 0;
      return acc;
    }, {});

    faults.forEach((fault) => {
      if (fault.status === "resolved" || !fault.assignee) {
        return;
      }
      if (load[fault.assignee] !== undefined) {
        load[fault.assignee] += 1;
      }
    });

    return availableNames.reduce((best, current) => {
      if (load[current] < load[best]) {
        return current;
      }
      return best;
    }, availableNames[0]);
  }

  async function handleAssign(faultId: string, assignee: string): Promise<void> {
    setUpdatingFaultId(faultId);
    try {
      await updateFaultStatus(faultId, "assigned", assignee);
      toast.success("Fault assigned", { description: `Fault ${faultId} assigned to ${assignee}.` });
    } catch (assignError) {
      toast.error("Assignment failed", {
        description: assignError instanceof Error ? assignError.message : "Unknown error",
      });
    } finally {
      setUpdatingFaultId(null);
    }
  }

  async function handleAutoAssign(faultId: string): Promise<void> {
    const autoAssignee = getAutoAssignee();
    await handleAssign(faultId, autoAssignee);
  }

  async function handleResolve(faultId: string): Promise<void> {
    setUpdatingFaultId(faultId);
    try {
      const resolvedBy = assigneeDrafts[faultId] ?? faults.find((item) => item.id === faultId)?.assignee ?? operatorNames[0];
      await updateFaultStatus(faultId, "resolved", resolvedBy);
      toast.success("Fault resolved", { description: `Fault ${faultId} marked resolved.` });
    } catch (resolveError) {
      toast.error("Resolve failed", {
        description: resolveError instanceof Error ? resolveError.message : "Unknown error",
      });
    } finally {
      setUpdatingFaultId(null);
    }
  }

  async function handleReopen(faultId: string): Promise<void> {
    setUpdatingFaultId(faultId);
    try {
      await updateFaultStatus(faultId, "unresolved", null);
      toast.info("Fault reopened", { description: `Fault ${faultId} moved back to unresolved.` });
    } catch (reopenError) {
      toast.error("Reopen failed", {
        description: reopenError instanceof Error ? reopenError.message : "Unknown error",
      });
    } finally {
      setUpdatingFaultId(null);
    }
  }

  async function toggleSimulator(run: boolean): Promise<void> {
    setSimBusy(true);
    try {
      const status = run ? await startSimulator() : await stopSimulator();
      setSimStatus(status);
      toast.success(run ? "Auto patrol started" : "Auto patrol stopped");
    } catch (simError) {
      toast.error("Simulator control failed", {
        description: simError instanceof Error ? simError.message : "Unknown error",
      });
    } finally {
      setSimBusy(false);
    }
  }

  async function applyScenarioPreset(name: "storm_day" | "vegetation_risk" | "high_load_corridor"): Promise<void> {
    setScenarioBusy(true);
    try {
      const status = await applyScenario(name);
      setSimStatus(status);
      toast.success("Scenario applied", {
        description: name.replaceAll("_", " "),
      });
    } catch (errorValue) {
      toast.error("Could not apply scenario", {
        description: errorValue instanceof Error ? errorValue.message : "Unknown error",
      });
    } finally {
      setScenarioBusy(false);
    }
  }

  async function handleDroneNavigate(droneId: string, direction: string): Promise<void> {
    setNavigatingDroneId(droneId);
    try {
      await navigateDrone(droneId, direction, manualStepMeters, manualOperator);
      toast.success(`Drone ${droneId} moved ${direction}`);
    } catch (errorValue) {
      toast.error("Navigation command failed", {
        description: errorValue instanceof Error ? errorValue.message : "Unknown error",
      });
    } finally {
      setNavigatingDroneId(null);
    }
  }

  async function handleDroneMode(droneId: string, mode: "auto" | "manual"): Promise<void> {
    setModeUpdatingDroneId(droneId);
    try {
      await setDroneMode(droneId, mode, manualOperator);
      toast.success(`Drone ${droneId} set to ${mode} mode`);
    } catch (errorValue) {
      toast.error("Could not change drone mode", {
        description: errorValue instanceof Error ? errorValue.message : "Unknown error",
      });
    } finally {
      setModeUpdatingDroneId(null);
    }
  }

  async function handleManualIdleTimeoutSave(): Promise<void> {
    const safeValue = Math.max(10, Math.min(1800, Math.round(manualIdleTimeoutDraft)));
    setTimeoutBusy(true);
    try {
      const status = await setManualIdleTimeout(safeValue);
      setSimStatus(status);
      setManualIdleTimeoutDraft(status.manual_idle_timeout_seconds);
      toast.success("Manual idle timeout updated", {
        description: `Manual drones return to auto after ${status.manual_idle_timeout_seconds}s without commands.`,
      });
    } catch (errorValue) {
      toast.error("Could not update timeout", {
        description: errorValue instanceof Error ? errorValue.message : "Unknown error",
      });
    } finally {
      setTimeoutBusy(false);
    }
  }

  async function handleMapWaypointClick(coords: { lat: number; lng: number }): Promise<void> {
    if (!selectedDrone || selectedDrone.controlMode !== "manual") {
      toast.info("Select a manual drone first");
      return;
    }

    if (selectedDroneLockedByOther) {
      toast.error("Drone is locked", {
        description: `Locked by ${selectedDrone.controlOwner}. Select that operator to command it.`,
      });
      return;
    }

    setPendingWaypoints((prev) => [...prev, { lat: coords.lat, lng: coords.lng }]);
  }

  async function handleConfirmWaypointQueue(): Promise<void> {
    if (!selectedDrone || pendingWaypoints.length === 0) {
      return;
    }

    setNavigatingDroneId(selectedDrone.id);
    try {
      await queueDroneWaypoints(selectedDrone.id, manualOperator, pendingWaypoints, false);
      setPendingWaypoints([]);
      toast.success(`Queued ${pendingWaypoints.length} waypoint(s)`, {
        description: `Drone ${selectedDrone.id} will follow them in sequence.`,
      });
    } catch (errorValue) {
      toast.error("Could not queue waypoints", {
        description: errorValue instanceof Error ? errorValue.message : "Unknown error",
      });
    } finally {
      setNavigatingDroneId(null);
    }
  }

  function handleCancelWaypointDraft(): void {
    setPendingWaypoints([]);
  }

  async function handleCancelCurrentWaypoints(): Promise<void> {
    if (!selectedDrone) {
      return;
    }
    setNavigatingDroneId(selectedDrone.id);
    try {
      await cancelDroneWaypoints(selectedDrone.id, manualOperator);
      toast.success(`Cleared active queue for ${selectedDrone.id}`);
    } catch (errorValue) {
      toast.error("Could not clear active queue", {
        description: errorValue instanceof Error ? errorValue.message : "Unknown error",
      });
    } finally {
      setNavigatingDroneId(null);
    }
  }

  async function handleReturnToOrigin(): Promise<void> {
    if (!selectedDrone) {
      return;
    }
    setNavigatingDroneId(selectedDrone.id);
    try {
      await returnDroneToOrigin(selectedDrone.id, manualOperator);
      setPendingWaypoints([]);
      toast.success(`Return to origin queued for ${selectedDrone.id}`);
    } catch (errorValue) {
      toast.error("Could not queue return-to-origin", {
        description: errorValue instanceof Error ? errorValue.message : "Unknown error",
      });
    } finally {
      setNavigatingDroneId(null);
    }
  }

  async function handleReleaseControl(): Promise<void> {
    if (!selectedDrone) {
      return;
    }
    setModeUpdatingDroneId(selectedDrone.id);
    try {
      await releaseDroneControl(selectedDrone.id, manualOperator);
      toast.success(`Control released on ${selectedDrone.id}`);
    } catch (errorValue) {
      toast.error("Could not release control", {
        description: errorValue instanceof Error ? errorValue.message : "Unknown error",
      });
    } finally {
      setModeUpdatingDroneId(null);
    }
  }

  const reportRows = useMemo(() => {
    const startDate = reportStartDate ? new Date(`${reportStartDate}T00:00:00`).getTime() : null;
    const endDate = reportEndDate ? new Date(`${reportEndDate}T23:59:59`).getTime() : null;

    return faults
      .filter((fault) => {
        if (!fault.detectedAt) {
          return true;
        }
        const detectedTime = new Date(fault.detectedAt).getTime();
        if (Number.isNaN(detectedTime)) {
          return true;
        }
        if (startDate !== null && detectedTime < startDate) {
          return false;
        }
        if (endDate !== null && detectedTime > endDate) {
          return false;
        }
        return true;
      })
      .slice(0, 300)
      .map((fault) => ({
      id: fault.id,
      droneId: fault.droneId,
      faultType: fault.faultType,
      severity: fault.severity,
      status: fault.status,
      assignee: fault.assignee ?? "",
      detectedAt: fault.detectedAt ?? "",
      lat: fault.lat,
      lng: fault.lng,
      confidence: fault.confidence,
    }));
  }, [faults, reportEndDate, reportStartDate]);

  const reportSummary = useMemo(() => {
    const total = reportRows.length;
    const resolved = reportRows.filter((row) => row.status === "resolved").length;
    const assigned = reportRows.filter((row) => row.status === "assigned").length;
    const unresolved = reportRows.filter((row) => row.status === "unresolved").length;
    const critical = reportRows.filter((row) => row.severity === "critical" || row.severity === "high").length;
    return { total, resolved, assigned, unresolved, critical };
  }, [reportRows]);

  function exportInspectionCsv(): void {
    const header = [
      "fault_id",
      "drone_id",
      "fault_type",
      "severity",
      "status",
      "assignee",
      "confidence",
      "latitude",
      "longitude",
      "detected_at",
    ];

    const lines = [
      header.join(","),
      ...reportRows.map((row) => [
        row.id,
        row.droneId,
        row.faultType,
        row.severity,
        row.status,
        row.assignee,
        row.confidence.toFixed(3),
        row.lat.toFixed(6),
        row.lng.toFixed(6),
        row.detectedAt,
      ].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")),
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `powerguard-inspection-report-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function printInspectionReport(): void {
    const popup = window.open("", "_blank", "width=980,height=720");
    if (!popup) {
      toast.error("Popup blocked", { description: "Allow popups to print reports." });
      return;
    }

    const rowsMarkup = reportRows
      .slice(0, 60)
      .map((row) => `<tr><td>${row.id}</td><td>${row.droneId}</td><td>${row.faultType}</td><td>${row.severity}</td><td>${row.status}</td><td>${row.assignee || "-"}</td><td>${(row.confidence * 100).toFixed(1)}%</td><td>${row.detectedAt || "-"}</td></tr>`)
      .join("");

    popup.document.write(`<!doctype html><html><head><title>PowerGuard Inspection Report</title><style>body{font-family:Segoe UI,Arial,sans-serif;padding:22px;color:#0f172a}h1{margin-bottom:6px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #cbd5e1;padding:6px;text-align:left}th{background:#e2e8f0} .stats{margin:12px 0 18px;display:flex;gap:14px;font-size:13px}</style></head><body><h1>PowerGuard Inspection Report</h1><div>Generated: ${new Date().toLocaleString()}</div><div class="stats"><span>Total: ${reportSummary.total}</span><span>Critical+: ${reportSummary.critical}</span><span>Assigned: ${reportSummary.assigned}</span><span>Resolved: ${reportSummary.resolved}</span><span>Unresolved: ${reportSummary.unresolved}</span></div><table><thead><tr><th>Fault ID</th><th>Drone</th><th>Type</th><th>Severity</th><th>Status</th><th>Assignee</th><th>Confidence</th><th>Detected At</th></tr></thead><tbody>${rowsMarkup}</tbody></table></body></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
  }

  function exportInspectionPdf(): void {
    if (reportRows.length === 0) {
      toast.info("No rows in selected range");
      return;
    }

    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(16);
    doc.text("PowerGuard Inspection Report", 14, 14);
    doc.setFontSize(10);
    const dateLabel = reportStartDate || reportEndDate
      ? `Range: ${reportStartDate || "Any"} to ${reportEndDate || "Any"}`
      : "Range: All dates";
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 21);
    doc.text(dateLabel, 14, 27);
    doc.text(
      `Total: ${reportSummary.total}  Critical+: ${reportSummary.critical}  Assigned: ${reportSummary.assigned}  Resolved: ${reportSummary.resolved}`,
      14,
      33,
    );

    autoTable(doc, {
      startY: 38,
      head: [["Fault", "Drone", "Type", "Severity", "Status", "Assignee", "Confidence", "Detected"]],
      body: reportRows.slice(0, 200).map((row) => [
        row.id,
        row.droneId,
        row.faultType,
        row.severity,
        row.status,
        row.assignee || "-",
        `${(row.confidence * 100).toFixed(1)}%`,
        row.detectedAt || "-",
      ]),
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: { fillColor: [25, 82, 114] },
    });

    doc.save(`powerguard-inspection-report-${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  async function handleResetDemoData(clearTeam: boolean): Promise<void> {
    const confirmed = window.confirm(
      clearTeam
        ? "This will clear drones, faults, and team roster. Continue?"
        : "This will clear drones and faults so you can start fresh. Continue?",
    );
    if (!confirmed) {
      return;
    }

    setResetBusy(true);
    try {
      await stopSimulator();
      const response = await resetLiveData(clearTeam);
      const status = await getSimulatorStatus();
      setSimStatus(status);
      toast.success("Start-fresh complete", {
        description: `Patrol stopped. Cleared ${response.cleared.drones} drones and ${response.cleared.faults} faults${clearTeam ? `, plus ${response.cleared.operators} team entries` : ""}.`,
      });
    } catch (resetError) {
      toast.error("Could not clear live data", {
        description: resetError instanceof Error ? resetError.message : "Unknown error",
      });
    } finally {
      setResetBusy(false);
    }
  }

  async function handleSeedTeam(): Promise<void> {
    setSeedBusy(true);
    try {
      const result = await seedSampleTeam();
      toast.success("Team roster ready", { description: `Created ${result.created} sample team entries.` });
    } catch (seedError) {
      toast.error("Could not create sample team", {
        description: seedError instanceof Error ? seedError.message : "Unknown error",
      });
    } finally {
      setSeedBusy(false);
    }
  }

  return (
    <main className={`command-root ${alertPulse === "high" ? "pulse-high" : ""} ${alertPulse === "medium" ? "pulse-medium" : ""}`.trim()}>
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: "rgba(6, 24, 35, 0.95)",
            color: "#d6e7f5",
            border: "1px solid rgba(96, 139, 168, 0.45)",
          },
          classNames: {
            title: "pg-toast-title",
            description: "pg-toast-description",
          },
        }}
      />

      <section className="map-layer">
        <CommandMap
          drones={drones}
          faults={faults}
          edgeEffectLevel={edgeEffectLevel}
          mapClickMode={selectedDrone && selectedDrone.controlMode === "manual" && waypointArmed ? "waypoint" : "none"}
          onMapClick={handleMapWaypointClick}
          waypointPreviewPath={waypointPreviewPath}
        />
      </section>

      <section ref={overlayRef} className="overlay-stage">
        <DraggableWidget
          id="title"
          title="Control Panel"
          className={draggingId === "title" ? "is-dragging" : undefined}
          onStartDrag={startDrag}
        >
          <div className="panel-title">
          <p className="eyebrow">PowerGuard // Command Center</p>
          <h1>Nigeria Grid Watch</h1>
          <p>Live telemetry and fault stream from autonomous line-inspection drones.</p>
          <div className="sim-controls">
            <span className={`sim-indicator ${simStatus?.running ? "active" : "idle"}`}>
              Auto Patrol: {simStatus?.running ? "Running" : "Stopped"}
            </span>
            <span className="sim-indicator">Scenario: {simStatus?.scenario?.replaceAll("_", " ") ?? "balanced"}</span>
            <button type="button" onClick={() => toggleSimulator(true)} disabled={simBusy || simStatus?.running === true}>
              Start
            </button>
            <button type="button" onClick={() => toggleSimulator(false)} disabled={simBusy || simStatus?.running === false}>
              Stop
            </button>
          </div>
          <div className="scenario-row">
            <button type="button" onClick={() => applyScenarioPreset("storm_day")} disabled={scenarioBusy}>Storm Day</button>
            <button type="button" onClick={() => applyScenarioPreset("vegetation_risk")} disabled={scenarioBusy}>Vegetation Risk</button>
            <button type="button" onClick={() => applyScenarioPreset("high_load_corridor")} disabled={scenarioBusy}>High Load Corridor</button>
          </div>
          <div className="scenario-row">
            <button type="button" onClick={() => setEdgeEffectLevel("subtle")} disabled={edgeEffectLevel === "subtle"}>Edge FX: Subtle</button>
            <button type="button" onClick={() => setEdgeEffectLevel("strong")} disabled={edgeEffectLevel === "strong"}>Edge FX: Strong</button>
          </div>
          </div>
        </DraggableWidget>

        <DraggableWidget
          id="metrics"
          title="Mission Metrics"
          className={draggingId === "metrics" ? "is-dragging" : undefined}
          onStartDrag={startDrag}
        >
          <div className="panel-metrics">
          <div>
            <p className="metric-label">Today Incidents</p>
            <p className="metric-value alert">{storyCards.todayIncidents}</p>
          </div>
          <div>
            <p className="metric-label">Resolved Count</p>
            <p className="metric-value">{storyCards.resolvedCount}</p>
          </div>
          <div>
            <p className="metric-label">Avg Response</p>
            <p className="metric-value">{storyCards.avgResponse}</p>
          </div>
          <div>
            <p className="metric-label">Active Team</p>
            <p className="metric-value">{storyCards.activeTeam}</p>
          </div>
          </div>
          <div className="metrics-subline">
            <span>Drones online: {activeDrones}</span>
            <span>High severity: {criticalFaults}</span>
            <span>Unresolved: {unresolvedFaults}</span>
          </div>
        </DraggableWidget>

        <DraggableWidget
          id="reports"
          title="Inspection Reports"
          className={draggingId === "reports" ? "is-dragging" : undefined}
          onStartDrag={startDrag}
        >
          <div className="panel-report">
            <h2>Inspection Reports</h2>
            <div className="report-metrics">
              <span>Total: {reportSummary.total}</span>
              <span>Critical+: {reportSummary.critical}</span>
              <span>Assigned: {reportSummary.assigned}</span>
              <span>Resolved: {reportSummary.resolved}</span>
            </div>
            <div className="report-range-row">
              <label>
                From
                <input
                  type="date"
                  value={reportStartDate}
                  onChange={(event) => setReportStartDate(event.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={reportEndDate}
                  onChange={(event) => setReportEndDate(event.target.value)}
                />
              </label>
              <button type="button" onClick={() => { setReportStartDate(""); setReportEndDate(""); }}>
                Clear
              </button>
            </div>
            <div className="report-actions">
              <button type="button" onClick={exportInspectionCsv} disabled={reportRows.length === 0}>Export CSV</button>
              <button type="button" onClick={exportInspectionPdf} disabled={reportRows.length === 0}>Export PDF</button>
              <button type="button" onClick={printInspectionReport} disabled={reportRows.length === 0}>Print Report</button>
            </div>
            <div className="report-actions">
              <button type="button" onClick={() => handleResetDemoData(false)} disabled={resetBusy}>Start Fresh</button>
              <button type="button" onClick={() => handleResetDemoData(true)} disabled={resetBusy}>Full Reset</button>
            </div>
            <p className="muted">Showing up to {Math.min(reportRows.length, 300)} items from the selected date range.</p>
          </div>
        </DraggableWidget>

        <DraggableWidget
          id="stream"
          title="Drone Telemetry"
          className={draggingId === "stream" ? "is-dragging" : undefined}
          onStartDrag={startDrag}
        >
          <div className="panel-stream">
          <h2>Drone Telemetry</h2>
          <div className="widget-scroll-body">
          <ul>
            {telemetryItems.map((drone) => (
              <li key={drone.id} className={`drone-row ${selectedDroneId === drone.id ? "selected" : ""}`}>
                <span className="drone-cell-main">
                  <strong>{drone.id}</strong>
                  <span>{prettyPercent(drone.battery)}</span>
                  <span>{drone.lat.toFixed(4)}, {drone.lng.toFixed(4)}</span>
                </span>
                <span className="drone-row-actions">
                  <span className={`mode-pill ${drone.controlMode}`}>{drone.controlMode}</span>
                  <button type="button" onClick={() => setSelectedDroneId(drone.id)}>Control</button>
                </span>
              </li>
            ))}
            {drones.length === 0 ? <li className="muted">No drone telemetry yet.</li> : null}
          </ul>
          </div>
          <div className="pager-row">
            <button type="button" onClick={() => setTelemetryPage((page) => Math.max(1, page - 1))} disabled={telemetryPage === 1}>Prev</button>
            <span>{telemetryPage} / {telemetryTotalPages}</span>
            <button type="button" onClick={() => setTelemetryPage((page) => Math.min(telemetryTotalPages, page + 1))} disabled={telemetryPage === telemetryTotalPages}>Next</button>
          </div>
          </div>
        </DraggableWidget>

        {selectedDrone ? (
          <DraggableWidget
            id="manual"
            title="Manual Drone Controls"
            className={draggingId === "manual" ? "is-dragging" : undefined}
            onStartDrag={startDrag}
          >
            <div className="panel-manual">
              <h2>Manual Patrol Console</h2>
              <div className="manual-head">
                <strong>{selectedDrone.id}</strong>
                <span className={`mode-pill ${selectedDrone.controlMode}`}>{selectedDrone.controlMode}</span>
              </div>
              <p className="muted">{selectedDrone.lat.toFixed(5)}, {selectedDrone.lng.toFixed(5)} | battery {prettyPercent(selectedDrone.battery)}</p>
              <div className="manual-actions-row">
                <label className="manual-step">
                  Operator
                  <select value={manualOperator} onChange={(event) => setManualOperator(event.target.value)}>
                    {operatorNames.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <span className="mode-pill manual-owner">Owner: {selectedDrone.controlOwner ?? "none"}</span>
                <button type="button" onClick={handleReleaseControl} disabled={modeUpdatingDroneId === selectedDrone.id}>Release Lock</button>
              </div>
              {selectedDroneLockedByOther ? (
                <p className="muted">This drone is locked by {selectedDrone.controlOwner}. Switch operator to command this drone.</p>
              ) : null}
              <div className="manual-actions-row">
                <button
                  type="button"
                  onClick={() => handleDroneMode(selectedDrone.id, "auto")}
                  disabled={modeUpdatingDroneId === selectedDrone.id || selectedDrone.controlMode === "auto" || selectedDroneLockedByOther}
                >
                  Set Auto
                </button>
                <button
                  type="button"
                  onClick={() => handleDroneMode(selectedDrone.id, "manual")}
                  disabled={modeUpdatingDroneId === selectedDrone.id || selectedDrone.controlMode === "manual" || selectedDroneLockedByOther}
                >
                  Set Manual
                </button>
                <label className="manual-step">
                  Step
                  <select value={manualStepMeters} onChange={(event) => setManualStepMeters(Number(event.target.value))}>
                    <option value={20}>20m</option>
                    <option value={35}>35m</option>
                    <option value={50}>50m</option>
                    <option value={70}>70m</option>
                  </select>
                </label>
              </div>
              <div className="manual-actions-row">
                <button
                  type="button"
                  onClick={() => setWaypointArmed((value) => !value)}
                  disabled={selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}
                  className={waypointArmed ? "is-active" : undefined}
                >
                  {waypointArmed ? "Waypoint Click: On" : "Waypoint Click: Off"}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmWaypointQueue}
                  disabled={selectedDroneLockedByOther || pendingWaypoints.length === 0 || navigatingDroneId === selectedDrone.id}
                >
                  Confirm Queue ({pendingWaypoints.length})
                </button>
                <button
                  type="button"
                  onClick={handleCancelWaypointDraft}
                  disabled={pendingWaypoints.length === 0}
                >
                  Cancel Draft
                </button>
                <button
                  type="button"
                  onClick={handleCancelCurrentWaypoints}
                  disabled={selectedDroneLockedByOther || selectedDrone.waypointQueueCount === 0 || navigatingDroneId === selectedDrone.id}
                >
                  Cancel Active Queue
                </button>
                <button
                  type="button"
                  onClick={handleReturnToOrigin}
                  disabled={selectedDroneLockedByOther || navigatingDroneId === selectedDrone.id}
                >
                  Return To Origin
                </button>
                <label className="manual-step">
                  Idle timeout
                  <input
                    type="number"
                    min={10}
                    max={1800}
                    step={5}
                    value={manualIdleTimeoutDraft}
                    onChange={(event) => setManualIdleTimeoutDraft(Number(event.target.value))}
                  />
                </label>
                <button type="button" onClick={handleManualIdleTimeoutSave} disabled={timeoutBusy}>
                  Save Timeout
                </button>
              </div>
              <p className="muted">Active queue: {selectedDrone.waypointQueueCount} | Draft queue: {pendingWaypoints.length}</p>
              <div className="manual-pad">
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "NW")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>NW</button>
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "N")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>N</button>
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "NE")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>NE</button>
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "W")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>W</button>
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "HOLD")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>Hold</button>
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "E")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>E</button>
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "SW")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>SW</button>
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "S")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>S</button>
                <button type="button" onClick={() => handleDroneNavigate(selectedDrone.id, "SE")} disabled={navigatingDroneId === selectedDrone.id || selectedDrone.controlMode !== "manual" || selectedDroneLockedByOther}>SE</button>
              </div>
            </div>
          </DraggableWidget>
        ) : null}

        <DraggableWidget
          id="faults"
          title="Fault Feed"
          className={draggingId === "faults" ? "is-dragging" : undefined}
          onStartDrag={startDrag}
        >
          <div className="panel-faults">
          <h2>Fault Feed</h2>
          <div className="widget-scroll-body">
          <ul>
            {faultFeedItems.map((fault) => (
              <li key={fault.id}>
                <span className={`severity ${fault.severity}`}>{fault.severity}</span>
                <span>{fault.faultType}</span>
                <span>{(fault.confidence * 100).toFixed(1)}%</span>
              </li>
            ))}
            {faults.length === 0 ? <li className="muted">No faults detected.</li> : null}
          </ul>
          </div>
          <div className="pager-row">
            <button type="button" onClick={() => setFaultFeedPage((page) => Math.max(1, page - 1))} disabled={faultFeedPage === 1}>Prev</button>
            <span>{faultFeedPage} / {faultFeedTotalPages}</span>
            <button type="button" onClick={() => setFaultFeedPage((page) => Math.min(faultFeedTotalPages, page + 1))} disabled={faultFeedPage === faultFeedTotalPages}>Next</button>
          </div>
          </div>
        </DraggableWidget>

        <DraggableWidget
          id="table"
          title="Assignment Workflow"
          className={draggingId === "table" ? "is-dragging" : undefined}
          onStartDrag={startDrag}
        >
          <div className="panel-table" aria-label="Fault workflow table">
          <h2>Assignment Workflow</h2>
          <div className="widget-scroll-body">
          <div className="fault-table" role="table" aria-label="Fault assignment status">
            <div className="fault-row fault-head" role="row">
              <span role="columnheader">Fault</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Assignee</span>
              <span role="columnheader">Actions</span>
            </div>
            {workflowItems.map((fault) => (
              <div className="fault-row" role="row" key={fault.id}>
                <span role="cell">{fault.faultType}</span>
                <span role="cell" className={`status-pill ${fault.status}`}>{fault.status}</span>
                <span role="cell">{fault.assignee ?? "-"}</span>
                <span role="cell" className="fault-actions">
                  <select
                    value={assigneeDrafts[fault.id] ?? fault.assignee ?? operatorNames[0]}
                    onChange={(event) => setAssigneeDrafts((prev) => ({ ...prev, [fault.id]: event.target.value }))}
                    disabled={updatingFaultId === fault.id}
                    aria-label={`Select operator for fault ${fault.id}`}
                  >
                    {operators.length === 0 ? <option value={operatorNames[0]}>{operatorNames[0]}</option> : null}
                    {operators.map((operator) => (
                      <option key={operator.id} value={operator.name}>
                        {operator.name} ({operator.shift}, {operator.availability})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => handleAssign(fault.id, assigneeDrafts[fault.id] ?? fault.assignee ?? operatorNames[0])}
                    disabled={updatingFaultId === fault.id || fault.status === "assigned"}
                    aria-label={`Assign fault ${fault.id}`}
                  >
                    Assign
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAutoAssign(fault.id)}
                    disabled={updatingFaultId === fault.id || fault.status === "assigned"}
                    aria-label={`Auto assign fault ${fault.id}`}
                  >
                    Auto
                  </button>
                  <button
                    type="button"
                    onClick={() => handleResolve(fault.id)}
                    disabled={updatingFaultId === fault.id || fault.status === "resolved"}
                    aria-label={`Resolve fault ${fault.id}`}
                  >
                    Resolve
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReopen(fault.id)}
                    disabled={updatingFaultId === fault.id || fault.status === "unresolved"}
                    aria-label={`Reopen fault ${fault.id}`}
                  >
                    Reopen
                  </button>
                </span>
              </div>
            ))}
            {faults.length === 0 ? (
              <div className="fault-row" role="row">
                <span role="cell" className="muted">No faults available for assignment.</span>
                <span role="cell" />
                <span role="cell" />
                <span role="cell" />
              </div>
            ) : null}
          </div>
          </div>
          <div className="pager-row">
            <button type="button" onClick={() => setWorkflowPage((page) => Math.max(1, page - 1))} disabled={workflowPage === 1}>Prev</button>
            <span>{workflowPage} / {workflowTotalPages}</span>
            <button type="button" onClick={() => setWorkflowPage((page) => Math.min(workflowTotalPages, page + 1))} disabled={workflowPage === workflowTotalPages}>Next</button>
          </div>
          <div className="operator-strip">
            {operators.length === 0 ? (
              <span className="muted">
                No team list yet.
                <button type="button" className="inline-action" onClick={handleSeedTeam} disabled={seedBusy}>
                  {seedBusy ? "Creating..." : "Create sample team"}
                </button>
              </span>
            ) : (
              operators.map((operator) => (
                <span key={operator.id} className={`operator-pill ${operator.availability}`}>
                  {operator.name} [{operator.shift}] {operator.availability}
                </span>
              ))
            )}
          </div>
          </div>
        </DraggableWidget>

        {error ? (
          <DraggableWidget
            id="error"
            title="System Alert"
            className={`panel-error ${draggingId === "error" ? "is-dragging" : ""}`}
            onStartDrag={startDrag}
          >
            <div>{error}</div>
          </DraggableWidget>
        ) : null}
      </section>
    </main>
  );
}
