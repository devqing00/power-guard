import { collection, doc, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";

import { db, ensureClientAuth, hasFirebaseConfig } from "./firebase";

export type DroneState = {
  id: string;
  lat: number;
  lng: number;
  altitude: number;
  battery: number;
  status: string;
  controlMode: "auto" | "manual";
  controlOwner: string | null;
  waypointQueueCount: number;
  waypointQueue: Array<{ lat: number; lng: number }>;
};

export type FaultState = {
  id: string;
  droneId: string;
  lat: number;
  lng: number;
  locationName: string | null;
  faultType: string;
  severity: string;
  confidence: number;
  status: "unresolved" | "assigned" | "resolved";
  assignee: string | null;
  detectedAt: string | null;
  assignedAt: string | null;
  resolvedAt: string | null;
};

export type FaultWorkflowStatus = "unresolved" | "assigned" | "resolved";

export type OperatorState = {
  id: string;
  name: string;
  availability: "online" | "busy" | "off";
  shift: string;
};

export type SimulatorStatus = {
  running: boolean;
  interval_seconds: number;
  analyze_every: number;
  drones: number;
  drones_per_location: number;
  movement_scale: number;
  location_radius_deg: number;
  fault_rate: number;
  manual_idle_timeout_seconds: number;
  scenario: string;
  last_error: string | null;
};

const BACKEND_API_BASE =
  process.env.NEXT_PUBLIC_BACKEND_API_BASE?.replace(/\/$/, "") ?? "http://127.0.0.1:8000/api/v1";

function isValidCoordinate(lat: number, lng: number): boolean {
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180;
}

export function subscribeToMonitoringData(
  onDrones: (drones: DroneState[]) => void,
  onFaults: (faults: FaultState[]) => void,
  onOperators: (operators: OperatorState[]) => void,
  onError: (message: string) => void,
): () => void {
  if (!hasFirebaseConfig || !db) {
    onError("Firebase env vars are missing in frontend/.env.local.");
    return () => {};
  }
  const firestore = db;

  let unsubDrones: (() => void) | null = null;
  let unsubFaults: (() => void) | null = null;
  let unsubOperators: (() => void) | null = null;
  let isCancelled = false;

  const formatPermissionError = (prefix: string, message: string): string => {
    if (message.includes("Missing or insufficient permissions")) {
      if (prefix.includes("Operators")) {
        return `${prefix}: Missing or insufficient permissions. Team roster access is blocked. Allow signed-in users to read the operators collection.`;
      }
      return `${prefix}: Missing or insufficient permissions. Allow signed-in users to read and write drones/faults data.`;
    }
    return `${prefix}: ${message}`;
  };

  ensureClientAuth()
    .then(() => {
      if (isCancelled) {
        return;
      }

      unsubDrones = onSnapshot(
        collection(firestore, "drones"),
        (snapshot) => {
          const drones = snapshot.docs
            .map((doc) => {
              const data = doc.data();
              const lat = Number(data.lat ?? 0);
              const lng = Number(data.lng ?? 0);
              if (!isValidCoordinate(lat, lng)) {
                return null;
              }

              return {
                id: doc.id,
                lat,
                lng,
                altitude: Number(data.altitude ?? 0),
                battery: Number(data.battery ?? 0),
                status: String(data.status ?? "unknown"),
                controlMode: String(data.control_mode ?? "auto") === "manual" ? "manual" : "auto",
                controlOwner: data.control_owner ? String(data.control_owner) : null,
                waypointQueueCount: Number(data.waypoint_queue_count ?? 0),
                waypointQueue: Array.isArray(data.waypoint_queue)
                  ? data.waypoint_queue
                      .map((item) => ({
                        lat: Number(item?.lat ?? 0),
                        lng: Number(item?.lng ?? 0),
                      }))
                      .filter((item) => isValidCoordinate(item.lat, item.lng))
                  : [],
              } satisfies DroneState;
            })
            .filter((drone): drone is DroneState => drone !== null);
          onDrones(drones);
        },
        (error) => onError(formatPermissionError("Drones listener error", error.message)),
      );

      unsubFaults = onSnapshot(
        collection(firestore, "faults"),
        (snapshot) => {
          const faults = snapshot.docs
            .map((doc) => {
              const data = doc.data();
              const lat = Number(data.lat ?? 0);
              const lng = Number(data.lng ?? 0);
              if (!isValidCoordinate(lat, lng)) {
                return null;
              }

              return {
                id: doc.id,
                droneId: String(data.drone_id ?? "unknown"),
                lat,
                lng,
                locationName: data.location_name ? String(data.location_name) : null,
                faultType: String(data.fault_type ?? "unknown"),
                severity: String(data.severity ?? "unknown"),
                confidence: Number(data.confidence ?? 0),
                status: (() => {
                  const current = String(data.status ?? "unresolved");
                  if (current === "assigned" || current === "resolved" || current === "unresolved") {
                    return current;
                  }
                  return "unresolved";
                })(),
                assignee: data.assignee ? String(data.assignee) : null,
                detectedAt: data.detected_at?.toDate?.()?.toISOString?.() ?? null,
                assignedAt: data.assigned_at?.toDate?.()?.toISOString?.() ?? null,
                resolvedAt: data.resolved_at?.toDate?.()?.toISOString?.() ?? null,
              } satisfies FaultState;
            })
            .filter((fault): fault is FaultState => fault !== null);
          onFaults(faults);
        },
        (error) => onError(formatPermissionError("Faults listener error", error.message)),
      );

      unsubOperators = onSnapshot(
        collection(firestore, "operators"),
        (snapshot) => {
          const operators = snapshot.docs.map((operatorDoc) => {
            const data = operatorDoc.data();
            const rawAvailability = String(data.availability ?? "online").toLowerCase();
            return {
              id: operatorDoc.id,
              name: String(data.name ?? operatorDoc.id),
              availability:
                rawAvailability === "busy" || rawAvailability === "off"
                  ? rawAvailability
                  : "online",
              shift: String(data.shift ?? "Day"),
            } satisfies OperatorState;
          });
          onOperators(operators);
        },
        (error) => onError(formatPermissionError("Operators listener error", error.message)),
      );
    })
    .catch((error) => {
      onError(`Firebase auth initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    });

  return () => {
    isCancelled = true;
    if (unsubDrones) {
      unsubDrones();
    }
    if (unsubFaults) {
      unsubFaults();
    }
    if (unsubOperators) {
      unsubOperators();
    }
  };
}

export async function updateFaultStatus(
  faultId: string,
  status: FaultWorkflowStatus,
  assignee: string | null,
): Promise<void> {
  if (!hasFirebaseConfig || !db) {
    throw new Error("Firebase env vars are missing in frontend/.env.local.");
  }
  const firestore = db;

  const ref = doc(collection(firestore, "faults"), faultId);
  if (status === "assigned") {
    await updateDoc(ref, {
      status,
      assignee,
      assigned_at: serverTimestamp(),
    });
    return;
  }

  if (status === "resolved") {
    await updateDoc(ref, {
      status,
      assignee,
      resolved_at: serverTimestamp(),
    });
    return;
  }

  await updateDoc(ref, {
    status,
    assignee: null,
  });
}

type SimulatorMutationResponse = {
  success: boolean;
  message: string;
  status: SimulatorStatus;
};

async function parseSimulatorResponse(response: Response): Promise<SimulatorMutationResponse> {
  if (!response.ok) {
    throw new Error(`Simulator request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as SimulatorMutationResponse;
}

export async function getSimulatorStatus(): Promise<SimulatorStatus> {
  const response = await fetch(`${BACKEND_API_BASE}/simulator/status`, {
    method: "GET",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Unable to fetch simulator status: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as SimulatorStatus;
}

export async function startSimulator(): Promise<SimulatorStatus> {
  const response = await fetch(`${BACKEND_API_BASE}/simulator/start`, {
    method: "POST",
  });
  const payload = await parseSimulatorResponse(response);
  return payload.status;
}

export async function stopSimulator(): Promise<SimulatorStatus> {
  const response = await fetch(`${BACKEND_API_BASE}/simulator/stop`, {
    method: "POST",
  });
  const payload = await parseSimulatorResponse(response);
  return payload.status;
}

export async function applyScenario(name: string): Promise<SimulatorStatus> {
  const response = await fetch(`${BACKEND_API_BASE}/simulator/scenario?name=${encodeURIComponent(name)}`, {
    method: "POST",
  });

  const payload = await parseSimulatorResponse(response);
  return payload.status;
}

type ResetResponse = {
  success: boolean;
  message: string;
  cleared: {
    drones: number;
    faults: number;
    operators: number;
  };
};

export async function resetLiveData(clearTeam = false): Promise<ResetResponse> {
  const response = await fetch(`${BACKEND_API_BASE}/demo/reset?clear_team=${clearTeam ? "true" : "false"}`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Unable to reset live data: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as ResetResponse;
}

type SeedTeamResponse = {
  success: boolean;
  message: string;
  created: number;
};

export async function seedSampleTeam(): Promise<SeedTeamResponse> {
  const response = await fetch(`${BACKEND_API_BASE}/demo/seed-team`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`Unable to create sample team: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as SeedTeamResponse;
}

type NavigateResponse = {
  success: boolean;
  message: string;
  result: {
    drone_id: string;
    message: string;
    lat: number | null;
    lng: number | null;
  };
};

export async function navigateDrone(droneId: string, direction: string, meters = 35, operator?: string): Promise<NavigateResponse> {
  const operatorParam = operator ? `&operator=${encodeURIComponent(operator)}` : "";
  const response = await fetch(
    `${BACKEND_API_BASE}/simulator/navigate?drone_id=${encodeURIComponent(droneId)}&direction=${encodeURIComponent(direction)}&meters=${encodeURIComponent(String(meters))}${operatorParam}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Unable to navigate drone: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as NavigateResponse;
}

export async function setDroneWaypoint(droneId: string, lat: number, lng: number, operator: string): Promise<NavigateResponse> {
  const response = await fetch(
    `${BACKEND_API_BASE}/simulator/waypoint?drone_id=${encodeURIComponent(droneId)}&lat=${encodeURIComponent(String(lat))}&lng=${encodeURIComponent(String(lng))}&operator=${encodeURIComponent(operator)}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Unable to set drone waypoint: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as NavigateResponse;
}

type ModeResponse = {
  success: boolean;
  message: string;
  result: {
    drone_id: string;
    mode: "auto" | "manual";
  };
};

export async function setDroneMode(droneId: string, mode: "auto" | "manual", operator?: string): Promise<ModeResponse> {
  const operatorParam = operator ? `&operator=${encodeURIComponent(operator)}` : "";
  const response = await fetch(
    `${BACKEND_API_BASE}/simulator/mode?drone_id=${encodeURIComponent(droneId)}&mode=${encodeURIComponent(mode)}${operatorParam}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Unable to update drone mode: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as ModeResponse;
}

export async function setManualIdleTimeout(seconds: number): Promise<SimulatorStatus> {
  const response = await fetch(
    `${BACKEND_API_BASE}/simulator/manual-timeout?seconds=${encodeURIComponent(String(seconds))}`,
    {
      method: "POST",
    },
  );

  const payload = await parseSimulatorResponse(response);
  return payload.status;
}

type WaypointQueueResponse = {
  success: boolean;
  message: string;
  result: {
    drone_id: string;
    message: string;
    waypoint_count?: number;
  };
};

export async function queueDroneWaypoints(
  droneId: string,
  operator: string,
  waypoints: Array<{ lat: number; lng: number }>,
  replace = false,
): Promise<WaypointQueueResponse> {
  const response = await fetch(`${BACKEND_API_BASE}/simulator/waypoint-queue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      drone_id: droneId,
      operator,
      replace,
      waypoints,
    }),
  });

  if (!response.ok) {
    throw new Error(`Unable to queue waypoints: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as WaypointQueueResponse;
}

export async function returnDroneToOrigin(droneId: string, operator: string): Promise<WaypointQueueResponse> {
  const response = await fetch(
    `${BACKEND_API_BASE}/simulator/return-origin?drone_id=${encodeURIComponent(droneId)}&operator=${encodeURIComponent(operator)}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Unable to return drone to origin: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as WaypointQueueResponse;
}

export async function cancelDroneWaypoints(droneId: string, operator: string): Promise<WaypointQueueResponse> {
  const response = await fetch(
    `${BACKEND_API_BASE}/simulator/cancel-waypoints?drone_id=${encodeURIComponent(droneId)}&operator=${encodeURIComponent(operator)}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Unable to cancel drone waypoints: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as WaypointQueueResponse;
}

type ReleaseControlResponse = {
  success: boolean;
  message: string;
  result: {
    drone_id: string;
    control_owner: string;
  };
};

export async function releaseDroneControl(droneId: string, operator: string): Promise<ReleaseControlResponse> {
  const response = await fetch(
    `${BACKEND_API_BASE}/simulator/release-control?drone_id=${encodeURIComponent(droneId)}&operator=${encodeURIComponent(operator)}`,
    {
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Unable to release drone control: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as ReleaseControlResponse;
}
