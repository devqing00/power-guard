"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mapboxgl, { Map, Marker, Popup } from "mapbox-gl";

import type { DroneState, FaultState } from "@/lib/monitoring";

type CommandMapProps = {
  drones: DroneState[];
  faults: FaultState[];
  viewCommand?: { id: number; type: "nigeria" | "recenter" };
  edgeEffectLevel?: "subtle" | "strong";
  mapClickMode?: "none" | "waypoint";
  onMapClick?: (coords: { lat: number; lng: number }) => void;
  waypointPreviewPath?: Array<{ lat: number; lng: number }>;
};

const severityColor: Record<string, string> = {
  critical: "#ff3b30",
  high: "#ff8a00",
  medium: "#ffd60a",
  low: "#7ee787",
};

const TRAIL_SAMPLE_MIN_DEG = 0.000006;
// Keep this in sync with .drone-marker::after translateY magnitude in globals.css.
const DRONE_TIP_OFFSET_PX = 8;

function normalizeAngle(angle: number): number {
  let normalized = angle;
  while (normalized <= -180) normalized += 360;
  while (normalized > 180) normalized -= 360;
  return normalized;
}

function blendAngle(current: number, target: number, blend: number): number {
  const delta = normalizeAngle(target - current);
  return normalizeAngle(current + delta * blend);
}

function isValidLngLat(coord: [number, number] | undefined): coord is [number, number] {
  if (!coord) {
    return false;
  }
  const [lng, lat] = coord;
  return Number.isFinite(lng) && Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isFinitePoint(point: { x: number; y: number }): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export default function CommandMap({
  drones,
  faults,
  viewCommand,
  edgeEffectLevel = "subtle",
  mapClickMode = "none",
  onMapClick,
  waypointPreviewPath = [],
}: CommandMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const droneMarkersRef = useRef<Record<string, Marker>>({});
  const droneTargetsRef = useRef<Record<string, [number, number]>>({});
  const droneRendersRef = useRef<Record<string, [number, number]>>({});
  const droneVelocityRef = useRef<Record<string, [number, number]>>({});
  const droneHeadingRef = useRef<Record<string, number>>({});
  const droneTargetAtRef = useRef<Record<string, number>>({});
  const droneTargetPrevRef = useRef<Record<string, [number, number]>>({});
  const interpolationFrameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number>(0);
  const faultMarkersRef = useRef<Record<string, Marker>>({});
  const droneTrailRef = useRef<Record<string, [number, number][]>>({});
  const [is3dEnabled, setIs3dEnabled] = useState(false);
  const [autoFollow, setAutoFollow] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string>("");

  const token = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

  const drawDroneTrails = useCallback(() => {
    if (!mapRef.current || !mapReady) {
      return;
    }

    const map = mapRef.current;
    const source = map.getSource("drone-trails") as mapboxgl.GeoJSONSource | undefined;
    if (!source) {
      return;
    }

    const features = Object.entries(droneTrailRef.current)
      .map(([droneId, path]) => {
        const sanitizedPath = path.filter((point) => isValidLngLat(point));
        const currentRender = droneRendersRef.current[droneId];
        let coordinates = sanitizedPath;

        // Keep history sampling sparse, but always render the visual tip at the live marker position.
        if (isValidLngLat(currentRender)) {
          const headingCandidate = droneHeadingRef.current[droneId] ?? 0;
          const headingDeg = Number.isFinite(headingCandidate) ? headingCandidate : 0;
          const headingRad = (headingDeg * Math.PI) / 180;
          const centerPx = map.project(currentRender);
          if (!isFinitePoint(centerPx)) {
            return [droneId, coordinates] as const;
          }

          const tipX = centerPx.x + Math.sin(headingRad) * DRONE_TIP_OFFSET_PX;
          const tipY = centerPx.y - Math.cos(headingRad) * DRONE_TIP_OFFSET_PX;
          if (!Number.isFinite(tipX) || !Number.isFinite(tipY)) {
            return [droneId, coordinates] as const;
          }

          const tipPx = new mapboxgl.Point(
            tipX,
            tipY,
          );
          let tipLngLat: mapboxgl.LngLat;
          try {
            tipLngLat = map.unproject(tipPx);
          } catch {
            return [droneId, coordinates] as const;
          }
          const tip: [number, number] = [tipLngLat.lng, tipLngLat.lat];
          if (!isValidLngLat(tip)) {
            return [droneId, coordinates] as const;
          }

          const last = coordinates[coordinates.length - 1];
          const isDifferent = !last
            || Math.abs(last[0] - tip[0]) > 0.0000001
            || Math.abs(last[1] - tip[1]) > 0.0000001;
          if (isDifferent) {
            coordinates = [...coordinates, tip];
          }
        }

        return [droneId, coordinates] as const;
      })
      .filter(([, coordinates]) => coordinates.length > 1)
      .map(([droneId, coordinates]) => ({
        type: "Feature" as const,
        properties: { droneId },
        geometry: {
          type: "LineString" as const,
          coordinates,
        },
      }));

    source.setData({
      type: "FeatureCollection",
      features,
    });
  }, [mapReady]);

  const recenterToOperations = useCallback(() => {
    if (!mapRef.current) {
      return;
    }

    const points: [number, number][] = [
      ...drones.map((drone) => [drone.lng, drone.lat] as [number, number]),
      ...faults.map((fault) => [fault.lng, fault.lat] as [number, number]),
    ];

    if (points.length === 0) {
      mapRef.current.easeTo({ center: [8.6753, 9.0820], zoom: 5.6, duration: 800 });
      return;
    }

    if (points.length === 1) {
      mapRef.current.easeTo({ center: points[0], zoom: 12.5, duration: 700 });
      return;
    }

    const bounds = new mapboxgl.LngLatBounds(points[0], points[0]);
    points.slice(1).forEach((point) => bounds.extend(point));

    mapRef.current.fitBounds(bounds, {
      padding: { top: 120, right: 120, bottom: 120, left: 120 },
      duration: 850,
      maxZoom: 13.5,
    });
  }, [drones, faults]);

  const toggle3DBuildings = useCallback(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }

    const nextValue = !is3dEnabled;
    setIs3dEnabled(nextValue);

    if (map.getLayer("3d-buildings")) {
      map.setLayoutProperty("3d-buildings", "visibility", nextValue ? "visible" : "none");
    }

    map.easeTo({
      pitch: nextValue ? 58 : 35,
      bearing: nextValue ? -18 : -12,
      duration: 650,
    });
  }, [is3dEnabled, mapReady]);

  const goNigeriaView = useCallback(() => {
    mapRef.current?.easeTo({
      center: [8.6753, 9.0820],
      zoom: 5.6,
      pitch: 8,
      bearing: 0,
      duration: 900,
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current || !token) return;

    const droneMarkers = droneMarkersRef.current;
    const faultMarkers = faultMarkersRef.current;

    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [3.3792, 6.5244],
      zoom: 10.4,
      pitch: 35,
      bearing: -12,
      antialias: true,
    });

    map.on("error", (event) => {
      const message = event?.error?.message ?? "Unknown Mapbox error.";
      setMapError(message);
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new mapboxgl.FullscreenControl(), "top-right");
    map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-right");
    map.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      "top-right",
    );

    map.on("load", () => {
      setMapError("");
      map.setFog({
        color: "rgb(5, 17, 25)",
        "high-color": "rgb(12, 46, 61)",
        "horizon-blend": 0.18,
      });

      map.addSource("drone-trails", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      map.addLayer({
        id: "drone-trails",
        type: "line",
        source: "drone-trails",
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "#1dd8ff",
          "line-width": 2.25,
          "line-opacity": 0.55,
        },
      });

      map.addSource("waypoint-preview", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [],
        },
      });

      map.addLayer({
        id: "waypoint-preview-line",
        type: "line",
        source: "waypoint-preview",
        filter: ["==", ["get", "kind"], "line"],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": "#ffe16b",
          "line-width": 2.2,
          "line-dasharray": [1.2, 1.2],
          "line-opacity": 0.85,
        },
      });

      map.addLayer({
        id: "waypoint-preview-points",
        type: "circle",
        source: "waypoint-preview",
        filter: ["==", ["get", "kind"], "point"],
        paint: {
          "circle-radius": 4,
          "circle-color": "#ffe16b",
          "circle-stroke-color": "#3b3420",
          "circle-stroke-width": 1.2,
          "circle-opacity": 0.9,
        },
      });

      map.addLayer({
        id: "3d-buildings",
        source: "composite",
        "source-layer": "building",
        filter: ["==", "extrude", "true"],
        type: "fill-extrusion",
        minzoom: 14,
        layout: {
          visibility: "none",
        },
        paint: {
          "fill-extrusion-color": "#275f77",
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": ["get", "min_height"],
          "fill-extrusion-opacity": 0.52,
        },
      });

      setMapReady(true);
      map.resize();
    });

    const onWindowResize = () => map.resize();
    window.addEventListener("resize", onWindowResize);

    mapRef.current = map;

    return () => {
      window.removeEventListener("resize", onWindowResize);
      if (interpolationFrameRef.current !== null) {
        window.cancelAnimationFrame(interpolationFrameRef.current);
        interpolationFrameRef.current = null;
      }
      Object.values(droneMarkers).forEach((marker) => marker.remove());
      Object.values(faultMarkers).forEach((marker) => marker.remove());
      map.remove();
      mapRef.current = null;
    };
  }, [token]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const onClick = (event: mapboxgl.MapMouseEvent) => {
      if (mapClickMode !== "waypoint" || !onMapClick) {
        return;
      }
      onMapClick({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [mapClickMode, onMapClick]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) {
      return;
    }

    const source = map.getSource("waypoint-preview") as mapboxgl.GeoJSONSource | undefined;
    if (!source) {
      return;
    }

    if (waypointPreviewPath.length < 2) {
      source.setData({
        type: "FeatureCollection",
        features: [],
      });
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { kind: "line" },
          geometry: {
            type: "LineString",
            coordinates: waypointPreviewPath.map((item) => [item.lng, item.lat]),
          },
        },
        ...waypointPreviewPath.slice(1).map((item) => ({
          type: "Feature" as const,
          properties: { kind: "point" },
          geometry: {
            type: "Point" as const,
            coordinates: [item.lng, item.lat],
          },
        })),
      ],
    });
  }, [mapReady, waypointPreviewPath]);

  useEffect(() => {
    if (!mapRef.current) return;

    const nextDroneIds = new Set<string>();
    drones.forEach((drone) => {
      const droneCoord: [number, number] = [drone.lng, drone.lat];
      if (!isValidLngLat(droneCoord)) {
        const staleMarker = droneMarkersRef.current[drone.id];
        if (staleMarker) {
          staleMarker.remove();
          delete droneMarkersRef.current[drone.id];
          delete droneTrailRef.current[drone.id];
          delete droneTargetsRef.current[drone.id];
          delete droneRendersRef.current[drone.id];
          delete droneVelocityRef.current[drone.id];
          delete droneHeadingRef.current[drone.id];
          delete droneTargetPrevRef.current[drone.id];
          delete droneTargetAtRef.current[drone.id];
        }
        return;
      }

      nextDroneIds.add(drone.id);
      const existing = droneMarkersRef.current[drone.id];
      const now = performance.now();
      const previousTarget = droneTargetPrevRef.current[drone.id] ?? droneCoord;
      const previousAt = droneTargetAtRef.current[drone.id] ?? now;
      const deltaSeconds = Math.max(0.05, (now - previousAt) / 1000);
      const measuredVelocity: [number, number] = [
        (drone.lng - previousTarget[0]) / deltaSeconds,
        (drone.lat - previousTarget[1]) / deltaSeconds,
      ];
      const priorVelocity = droneVelocityRef.current[drone.id] ?? measuredVelocity;
      droneVelocityRef.current[drone.id] = [
        priorVelocity[0] * 0.45 + measuredVelocity[0] * 0.55,
        priorVelocity[1] * 0.45 + measuredVelocity[1] * 0.55,
      ];
      droneTargetPrevRef.current[drone.id] = droneCoord;
      droneTargetAtRef.current[drone.id] = now;
      droneTargetsRef.current[drone.id] = droneCoord;
      if (existing) {
        return;
      }

      const el = document.createElement("div");
      el.className = "drone-marker";
      droneRendersRef.current[drone.id] = droneCoord;
      droneTrailRef.current[drone.id] = [droneCoord];
      droneHeadingRef.current[drone.id] = 0;
      droneMarkersRef.current[drone.id] = new mapboxgl.Marker(el)
        .setLngLat(droneCoord)
        .setPopup(
          new Popup({ closeButton: false, className: "pg-popup" }).setHTML(
            `<div class="popup-body"><h4>${drone.id}</h4><p>Battery: ${drone.battery.toFixed(0)}%</p><p>Status: ${drone.status}</p></div>`,
          ),
        )
        .addTo(mapRef.current!);
    });

    Object.keys(droneMarkersRef.current).forEach((droneId) => {
      if (nextDroneIds.has(droneId)) {
        return;
      }
      droneMarkersRef.current[droneId].remove();
      delete droneMarkersRef.current[droneId];
      delete droneTrailRef.current[droneId];
      delete droneTargetsRef.current[droneId];
      delete droneRendersRef.current[droneId];
      delete droneVelocityRef.current[droneId];
      delete droneHeadingRef.current[droneId];
      delete droneTargetPrevRef.current[droneId];
      delete droneTargetAtRef.current[droneId];
    });

    drawDroneTrails();

    const validDronePoints = drones
      .map((drone) => [drone.lng, drone.lat] as [number, number])
      .filter((point) => isValidLngLat(point));

    if (autoFollow && validDronePoints.length > 0) {
      const bounds = new mapboxgl.LngLatBounds(validDronePoints[0], validDronePoints[0]);
      validDronePoints.slice(1).forEach((point) => bounds.extend(point));

      mapRef.current.fitBounds(bounds, {
        padding: { top: 180, right: 220, bottom: 100, left: 100 },
        duration: 650,
        maxZoom: 13.4,
      });
    }
  }, [autoFollow, drawDroneTrails, drones]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }

    const tick = () => {
      const now = performance.now();
      const frameDeltaMs = lastFrameAtRef.current ? now - lastFrameAtRef.current : 16.6;
      lastFrameAtRef.current = now;
      const blend = Math.min(0.38, Math.max(0.12, frameDeltaMs / 95));
      let trailsChanged = false;
      let markersMoved = false;

      Object.entries(droneMarkersRef.current).forEach(([droneId, marker]) => {
        const target = droneTargetsRef.current[droneId];
        const render = droneRendersRef.current[droneId];
        if (!isValidLngLat(target) || !isValidLngLat(render)) {
          return;
        }

        const velocity = droneVelocityRef.current[droneId] ?? [0, 0];
        const lookAheadSeconds = Math.min(0.45, frameDeltaMs / 1000 * 1.5);
        const predictedTarget: [number, number] = [
          target[0] + velocity[0] * lookAheadSeconds,
          target[1] + velocity[1] * lookAheadSeconds,
        ];
        const nextLng = render[0] + (predictedTarget[0] - render[0]) * blend;
        const nextLat = render[1] + (predictedTarget[1] - render[1]) * blend;
        if (!isValidLngLat([nextLng, nextLat])) {
          return;
        }

        const moveLng = nextLng - render[0];
        const moveLat = nextLat - render[1];
        if (Math.abs(moveLng) + Math.abs(moveLat) > 0.00000005) {
          markersMoved = true;
        }
        if (Math.abs(moveLng) + Math.abs(moveLat) > 0.000001 && mapRef.current) {
          const from = mapRef.current.project([render[0], render[1]]);
          const to = mapRef.current.project([nextLng, nextLat]);
          if (!Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(to.x) || !Number.isFinite(to.y)) {
            return;
          }
          const screenDx = to.x - from.x;
          const screenDy = to.y - from.y;
          // 0deg points up; positive rotates clockwise to align with CSS marker arrow.
          const headingDeg = (Math.atan2(screenDx, -screenDy) * 180) / Math.PI;
          const priorHeading = droneHeadingRef.current[droneId] ?? headingDeg;
          const smoothHeading = blendAngle(priorHeading, headingDeg, 0.24);
          droneHeadingRef.current[droneId] = smoothHeading;
          marker.getElement().style.setProperty("--drone-heading", `${smoothHeading}deg`);

          const path: [number, number][] = droneTrailRef.current[droneId] ?? [[render[0], render[1]]];
          const last = path[path.length - 1];
          const movedEnough = !last
            || Math.abs(last[0] - nextLng) > TRAIL_SAMPLE_MIN_DEG
            || Math.abs(last[1] - nextLat) > TRAIL_SAMPLE_MIN_DEG;
          if (movedEnough) {
            const nextPoint: [number, number] = [nextLng, nextLat];
            droneTrailRef.current[droneId] = [...path, nextPoint].slice(-42);
            trailsChanged = true;
          }
        }
        droneRendersRef.current[droneId] = [nextLng, nextLat];
        marker.setLngLat([nextLng, nextLat]);
      });

      if (trailsChanged || markersMoved) {
        drawDroneTrails();
      }

      interpolationFrameRef.current = window.requestAnimationFrame(tick);
    };

    interpolationFrameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (interpolationFrameRef.current !== null) {
        window.cancelAnimationFrame(interpolationFrameRef.current);
        interpolationFrameRef.current = null;
      }
    };
  }, [drawDroneTrails, mapReady]);

  useEffect(() => {
    if (!mapRef.current) return;

    const nextFaultIds = new Set<string>();
    faults.forEach((fault) => {
      const faultCoord: [number, number] = [fault.lng, fault.lat];
      if (!isValidLngLat(faultCoord)) {
        return;
      }

      nextFaultIds.add(fault.id);
      const existing = faultMarkersRef.current[fault.id];
      if (existing) {
        existing.setLngLat(faultCoord);
        return;
      }

      const el = document.createElement("div");
      el.className = "fault-marker";
      el.style.background = severityColor[fault.severity] ?? "#f0f6fc";

      faultMarkersRef.current[fault.id] = new mapboxgl.Marker(el)
        .setLngLat(faultCoord)
        .setPopup(
          new Popup({ closeButton: false, className: "pg-popup" }).setHTML(
            `<div class="popup-body"><h4>${fault.faultType}</h4><p>Severity: ${fault.severity}</p><p>Confidence: ${(fault.confidence * 100).toFixed(1)}%</p></div>`,
          ),
        )
        .addTo(mapRef.current!);
    });

    Object.keys(faultMarkersRef.current).forEach((faultId) => {
      if (nextFaultIds.has(faultId)) {
        return;
      }
      faultMarkersRef.current[faultId].remove();
      delete faultMarkersRef.current[faultId];
    });
  }, [faults]);

  useEffect(() => {
    if (!mapRef.current || !mapReady) {
      return;
    }

    if (mapRef.current.getLayer("3d-buildings")) {
      mapRef.current.setLayoutProperty("3d-buildings", "visibility", is3dEnabled ? "visible" : "none");
    }
  }, [is3dEnabled, mapReady]);

  useEffect(() => {
    if (!viewCommand || !mapReady) {
      return;
    }
    if (viewCommand.type === "nigeria") {
      goNigeriaView();
      return;
    }
    recenterToOperations();
  }, [viewCommand, mapReady, goNigeriaView, recenterToOperations]);

  if (!token) {
    return (
      <div className="map-shell map-empty">
        NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN is missing in frontend/.env.local.
      </div>
    );
  }

  return (
    <div className={`map-shell map-wrap map-wrap-${edgeEffectLevel}`}>
      <div ref={containerRef} className={`map-canvas ${mapClickMode === "waypoint" ? "map-canvas-waypoint" : ""}`.trim()} />

      {mapClickMode === "waypoint" ? (
        <div className="map-waypoint-hint" role="status" aria-live="polite">
          Waypoint mode active: click map to add draft points, then confirm queue
        </div>
      ) : null}

      {mapError ? (
        <div className="map-load-error" role="status" aria-live="polite">
          Map load issue: {mapError}
        </div>
      ) : null}

      <button
        type="button"
        className={`map-ops-toggle ${showControls ? "open" : ""}`}
        onClick={() => setShowControls((value) => !value)}
        aria-controls="map-ops-panel"
      >
        {showControls ? "Hide Map Tools" : "Map Tools"}
      </button>

      <aside
        id="map-ops-panel"
        className={`map-ops ${showControls ? "open" : "hidden"}`}
        aria-label="Map operations"
      >
        <button type="button" className="map-op-btn" onClick={recenterToOperations}>
          Recenter Ops
        </button>
        <button type="button" className="map-op-btn" onClick={() => setAutoFollow((value) => !value)}>
          Auto-follow: {autoFollow ? "On" : "Off"}
        </button>
        <button type="button" className="map-op-btn" onClick={toggle3DBuildings}>
          3D: {is3dEnabled ? "On" : "Off"}
        </button>
        <button
          type="button"
          className="map-op-btn"
          onClick={goNigeriaView}
        >
          Nigeria View
        </button>
      </aside>
    </div>
  );
}
