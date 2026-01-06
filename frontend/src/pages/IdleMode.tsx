import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import { Link } from 'react-router-dom';

import { auth, db } from '../firebase';
import useOwnerRoom from '../hooks/useOwnerRoom';
import useUserProfile from '../hooks/useUserProfile';
import TableMateLogo from '../TableMateAssets/TableMateLogoOfficial.png';
import Footer from '../components/Footer';
import './IdleMode.css';

type ZoneType = 'Table' | 'Door';

type Zone = {
  id: string;
  name: string;
  type: ZoneType;
  rect: { x: number; y: number; w: number; h: number };
  cameraId?: string | null;
  dineInActive?: boolean;
  dineInStartedAt?: Timestamp | null;
  dineInPartySize?: number | null;
};

type UserCamera = {
  id: string;
  deviceId: string;
  label: string;
  lastSeen?: Timestamp;
};

type CameraAlert = {
  zoneName: string;
  cameraLabel: string;
  cameraId: string;
};

const HAND_GESTURE_CLASSES = new Set(['stop', 'palm', 'raised', 'three2', 'three3']);
const PERSON_GESTURE_CLASSES = new Set(['palm']);
const PEOPLE_LINE_Y = 0.6;

const IdleMode: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const { profile, user } = useUserProfile();
  const ownerRoom = useOwnerRoom(user?.uid);
  const [zones, setZones] = useState<Zone[]>([]);
  const [error, setError] = useState('');
  const [assistanceZones, setAssistanceZones] = useState<CameraAlert[]>([]);
  const [doorZonesDetected, setDoorZonesDetected] = useState<CameraAlert[]>([]);
  const [unzonedAssistance, setUnzonedAssistance] = useState<string[]>([]);
  const [handDetections, setHandDetections] = useState<
    { x: number; y: number; width: number; height: number; label: string; confidence: number }[]
  >([]);
  const [peopleDetections, setPeopleDetections] = useState<
    { id: number; x: number; y: number; width: number; height: number; confidence: number }[]
  >([]);
  const [peopleCount, setPeopleCount] = useState(0);
  const [cameraQuality, setCameraQuality] = useState<'Good' | 'Okay' | 'Poor'>('Okay');
  const [viewMode, setViewMode] = useState<'all' | 'camera' | 'alerts' | 'settings' | 'management'>('all');
  const [activeCameraId, setActiveCameraId] = useState('');
  const [showAllCameras, setShowAllCameras] = useState(false);
  const [availableDeviceIds, setAvailableDeviceIds] = useState<string[]>([]);
  const [personAssistance, setPersonAssistance] = useState<string[]>([]);
  const [handGestureThreshold, setHandGestureThreshold] = useState(
    profile?.handGestureThreshold ?? 0.45
  );
  const [handModelConfidence, setHandModelConfidence] = useState(
    profile?.handModelConfidence ?? 0.45
  );
  const [modelOverlap, setModelOverlap] = useState(profile?.modelOverlap ?? 0.3);
  const [highAccuracyMode, setHighAccuracyMode] = useState(
    profile?.highAccuracyMode ?? false
  );
  const [flashNotifications, setFlashNotifications] = useState(
    profile?.flashNotifications ?? true
  );
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [doorOverlayDismissed, setDoorOverlayDismissed] = useState(false);
  const [doorCooldownUntil, setDoorCooldownUntil] = useState(0);
  const [lastAlertKey, setLastAlertKey] = useState('');
  const [thresholdStatus, setThresholdStatus] = useState('');
  const [cameras, setCameras] = useState<UserCamera[]>([]);
  const [testNotification, setTestNotification] = useState<{
    active: boolean;
    message: string;
    subtitle: string;
  }>({ active: false, message: '', subtitle: '' });
  const [now, setNow] = useState(Date.now());
  const [managementCameraId, setManagementCameraId] = useState('');
  const lastAlertRef = useRef<string>('');
  const lastMainCameraStatusRef = useRef<'active' | 'disabled' | ''>('');
  const inferenceInFlight = useRef(false);
  const cameraCycleRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const streamRefs = useRef<Record<string, MediaStream | null>>({});
  const lastSeenRef = useRef<Record<string, number>>({});
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const testTimeoutRef = useRef<number | null>(null);
  const doorTimeoutRef = useRef<number | null>(null);
  const doorActiveRef = useRef(false);

  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5050';

  const ensureVideoElement = (cameraId: string) => {
    if (!videoRefs.current[cameraId]) {
      const tempVideo = document.createElement('video');
      tempVideo.muted = true;
      tempVideo.playsInline = true;
      videoRefs.current[cameraId] = tempVideo;
    }
    return videoRefs.current[cameraId];
  };

  const attachStreamToVideo = (cameraId: string, stream: MediaStream) => {
    const videoEl = ensureVideoElement(cameraId);
    if (videoEl && videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
      void videoEl.play().catch(() => {});
    }
  };

  const stopStream = (cameraId?: string) => {
    if (cameraId) {
      const stream = streamRefs.current[cameraId];
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        streamRefs.current[cameraId] = null;
      }
      return;
    }
    Object.keys(streamRefs.current).forEach((id) => stopStream(id));
  };

  const startStreamForCamera = async (camera: UserCamera) => {
    if (!camera.deviceId) return;
    const constraints: MediaStreamConstraints = {
      video: { deviceId: { ideal: camera.deviceId } },
      audio: false,
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRefs.current[camera.id] = stream;
      attachStreamToVideo(camera.id, stream);
      if (camera.id === activeCameraId) {
        setError('');
      }
    } catch (err) {
      if (camera.id === activeCameraId) {
        const message = err instanceof Error ? err.message : 'Unable to access camera.';
        setError(message);
      }
    }
  };

  const activeCamera = useMemo(
    () => cameras.find((camera) => camera.id === activeCameraId) || cameras[0],
    [cameras, activeCameraId]
  );
  const availableDeviceSet = useMemo(
    () => new Set(availableDeviceIds),
    [availableDeviceIds]
  );
  const isActiveCameraMissing = Boolean(
    activeCamera?.deviceId && !availableDeviceSet.has(activeCamera.deviceId)
  );
  const zonesByCamera = useMemo(() => {
    const map = new Map<string, Zone[]>();
    zones.forEach((zone) => {
      const key = zone.cameraId || profile?.primaryCameraId || 'unassigned';
      const list = map.get(key) ?? [];
      list.push(zone);
      map.set(key, list);
    });
    return map;
  }, [zones, profile?.primaryCameraId]);
  const activeZones = useMemo(() => {
    if (!activeCamera?.id) return [];
    return zonesByCamera.get(activeCamera.id) ?? [];
  }, [zonesByCamera, activeCamera?.id]);
  const displayCameras = useMemo(() => {
    if (showAllCameras) return cameras;
    return activeCamera ? [activeCamera] : [];
  }, [showAllCameras, cameras, activeCamera]);
  const cameraLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    cameras.forEach((camera, index) => {
      map.set(camera.id, camera.label || `Dining Room ${index + 1}`);
    });
    return map;
  }, [cameras]);
  const tableZonesByCamera = useMemo(() => {
    const map = new Map<string, Zone[]>();
    zones
      .filter((zone) => zone.type === 'Table')
      .forEach((zone) => {
        if (!zone.cameraId) return;
        const list = map.get(zone.cameraId) ?? [];
        list.push(zone);
        map.set(zone.cameraId, list);
      });
    return map;
  }, [zones]);
  const managementCamera = useMemo(
    () => cameras.find((camera) => camera.id === managementCameraId) || cameras[0],
    [cameras, managementCameraId]
  );
  const managementZones = useMemo(
    () => (managementCamera ? tableZonesByCamera.get(managementCamera.id) ?? [] : []),
    [managementCamera, tableZonesByCamera]
  );
  const activeSessions = useMemo(
    () => zones.filter((zone) => zone.type === 'Table' && zone.dineInActive),
    [zones]
  );

  useEffect(() => {
    if (cameras.length === 0) return;
    if (!activeCameraId) {
      const fallback = profile?.primaryCameraId || cameras[0].id;
      setActiveCameraId(fallback);
    }
  }, [cameras, activeCameraId, profile?.primaryCameraId]);

  useEffect(() => {
    if (cameras.length === 0) return;
    if (!managementCameraId) {
      setManagementCameraId(cameras[0].id);
    }
  }, [cameras, managementCameraId]);

  useEffect(() => {
    const refreshDevices = async () => {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = allDevices.filter((device) => device.kind === 'videoinput');
      setAvailableDeviceIds(videoDevices.map((device) => device.deviceId));
    };
    void refreshDevices();
    const handleDeviceChange = () => {
      void refreshDevices();
    };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, []);

  useEffect(() => {
    const targetIds = new Set(cameras.map((camera) => camera.id));
    Object.keys(streamRefs.current).forEach((id) => {
      if (!targetIds.has(id)) {
        stopStream(id);
      }
    });
    cameras.forEach((camera) => {
      if (!streamRefs.current[camera.id] && availableDeviceSet.has(camera.deviceId)) {
        void startStreamForCamera(camera);
      }
    });
    if (isActiveCameraMissing) {
      setError('Camera has been disconnected!');
      stopStream(activeCamera?.id);
    }
  }, [
    cameras,
    availableDeviceSet,
    isActiveCameraMissing,
    activeCamera?.id,
  ]);

  useEffect(() => {
    return () => {
      stopStream();
    };
  }, []);

  useEffect(() => {
    if (profile?.handGestureThreshold !== undefined) {
      setHandGestureThreshold(profile.handGestureThreshold);
    }
    if (profile?.handModelConfidence !== undefined) {
      setHandModelConfidence(profile.handModelConfidence);
    }
    if (profile?.modelOverlap !== undefined) {
      setModelOverlap(profile.modelOverlap);
    }
    if (profile?.highAccuracyMode !== undefined) {
      setHighAccuracyMode(profile.highAccuracyMode);
    }
    if (profile?.flashNotifications !== undefined) {
      setFlashNotifications(profile.flashNotifications);
    }
  }, [
    profile?.handGestureThreshold,
    profile?.handModelConfidence,
    profile?.modelOverlap,
    profile?.highAccuracyMode,
    profile?.flashNotifications,
  ]);

  useEffect(() => {
    if (!user) return;
    const camerasRef = collection(db, 'users', user.uid, 'cameras');
    const camerasQuery = query(camerasRef, orderBy('createdAt', 'asc'));
    const unsubscribe = onSnapshot(camerasQuery, (snapshot) => {
      const nextCameras = snapshot.docs.map((docSnap, index) => {
        const data = docSnap.data() as UserCamera;
        return {
          id: docSnap.id,
          deviceId: data.deviceId,
          label: data.label || `Cam ${index + 1}`,
          lastSeen: data.lastSeen,
        };
      });
      setCameras(nextCameras);
    });
    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!ownerRoom || !user) return;
    const now = Date.now();
    const hasActiveCamera = cameras.some((camera) => {
      if (!camera.lastSeen) return false;
      return now - camera.lastSeen.toDate().getTime() < 30000;
    });
    const nextStatus: 'active' | 'disabled' = hasActiveCamera ? 'active' : 'disabled';
    if (lastMainCameraStatusRef.current === nextStatus) return;
    lastMainCameraStatusRef.current = nextStatus;
    void updateDoc(doc(db, 'rooms', ownerRoom.id), {
      mainCameraStatus: nextStatus,
      mainCameraStatusAt: serverTimestamp(),
      mainCameraMessage:
        nextStatus === 'disabled' ? 'Main Camera has been Disabled' : null,
    });
  }, [cameras, ownerRoom, user]);

  useEffect(() => {
    return () => {
      if (testTimeoutRef.current) {
        window.clearTimeout(testTimeoutRef.current);
      }
      if (doorTimeoutRef.current) {
        window.clearTimeout(doorTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const triggerOverlay = (message: string, subtitle: string, durationMs = 3500) => {
    if (testTimeoutRef.current) {
      window.clearTimeout(testTimeoutRef.current);
    }
    setTestNotification({ active: true, message, subtitle });
    testTimeoutRef.current = window.setTimeout(() => {
      setTestNotification({ active: false, message: '', subtitle: '' });
    }, durationMs);
  };

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (activeCamera && availableDeviceSet.has(activeCamera.deviceId)) {
          void startStreamForCamera(activeCamera);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [activeCamera, availableDeviceSet]);

  useEffect(() => {
    if (!user) return;
    const zoneQuery = query(collection(db, 'users', user.uid, 'zones'));
    const unsubscribe = onSnapshot(zoneQuery, (snapshot) => {
      const nextZones = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as Zone;
        return {
          id: docSnap.id,
          name: data.name,
          type: data.type,
          rect: data.rect,
          cameraId: data.cameraId,
          dineInActive: data.dineInActive ?? false,
          dineInStartedAt: data.dineInStartedAt ?? null,
          dineInPartySize: data.dineInPartySize ?? null,
        };
      });
      setZones(nextZones);
    });
    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const resize = () => {
      const rect = video.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
    };

    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [activeCamera?.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    activeZones.forEach((zone) => {
      const x = zone.rect.x * canvas.width;
      const y = zone.rect.y * canvas.height;
      const w = zone.rect.w * canvas.width;
      const h = zone.rect.h * canvas.height;
      ctx.strokeStyle = zone.type === 'Table' ? '#2b3a67' : '#e17b4f';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(x, y - 22, 140, 20);
      ctx.fillStyle = '#fff';
      ctx.font = '12px Sora, sans-serif';
      ctx.fillText(`${zone.name} • ${zone.type}`, x + 6, y - 7);
    });

    if (video && video.videoWidth && video.videoHeight) {
      peopleDetections.forEach((pred) => {
        const x = (pred.x - pred.width / 2) * (canvas.width / video.videoWidth);
        const y = (pred.y - pred.height / 2) * (canvas.height / video.videoHeight);
        const w = pred.width * (canvas.width / video.videoWidth);
        const h = pred.height * (canvas.height / video.videoHeight);

        ctx.strokeStyle = '#7aa7ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(12, 24, 54, 0.7)';
        ctx.fillRect(x, y - 18, 110, 16);
        ctx.fillStyle = '#fff';
        ctx.font = '12px Sora, sans-serif';
        ctx.fillText(`Person ${pred.id}`, x + 6, y - 6);
      });
      handDetections.forEach((pred) => {
        const x = (pred.x - pred.width / 2) * (canvas.width / video.videoWidth);
        const y = (pred.y - pred.height / 2) * (canvas.height / video.videoHeight);
        const w = pred.width * (canvas.width / video.videoWidth);
        const h = pred.height * (canvas.height / video.videoHeight);
        const label = pred.label;

        ctx.strokeStyle = '#6ef7a2';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(x, y - 18, 120, 16);
        ctx.fillStyle = '#fff';
        ctx.font = '12px Sora, sans-serif';
        ctx.fillText(`${label} ${Math.round(pred.confidence * 100)}%`, x + 6, y - 6);
      });
    }
  }, [activeZones, handDetections, peopleDetections]);

  useEffect(() => {
    if (cameras.length === 0) return;
    let isActive = true;
    const interval = setInterval(async () => {
      if (!isActive) return;
      if (inferenceInFlight.current) return;
      inferenceInFlight.current = true;

      try {
        const nextAssistance: CameraAlert[] = [];
        const nextDoorZones: CameraAlert[] = [];
        const nextUnzoned: string[] = [];
        const personHits = new Set<string>();
        let totalPeople = 0;

        const detectionTargets = cameras;
        const batchSize = detectionTargets.length > 3 ? 3 : detectionTargets.length;
        if (batchSize === 0) {
          inferenceInFlight.current = false;
          return;
        }
        const startIndex = cameraCycleRef.current % detectionTargets.length;
        const batch: UserCamera[] = [];
        for (let i = 0; i < batchSize; i += 1) {
          batch.push(detectionTargets[(startIndex + i) % detectionTargets.length]);
        }
        cameraCycleRef.current = (startIndex + batchSize) % detectionTargets.length;

        for (const camera of batch) {
          if (!availableDeviceSet.has(camera.deviceId)) {
            if (camera.id === activeCameraId) {
              setError('Camera has been disconnected!');
            }
            continue;
          }
          const video = videoRefs.current[camera.id];
          if (!video || video.videoWidth === 0) continue;

          const captureCanvas = document.createElement('canvas');
          const maxWidth = highAccuracyMode ? 1280 : 640;
          const scale = Math.min(1, maxWidth / video.videoWidth);
          captureCanvas.width = Math.round(video.videoWidth * scale);
          captureCanvas.height = Math.round(video.videoHeight * scale);
          const ctx = captureCanvas.getContext('2d');
          if (!ctx) continue;
          ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

          if (camera.id === activeCameraId) {
            const pixels = ctx.getImageData(0, 0, captureCanvas.width, captureCanvas.height).data;
            let sum = 0;
            let sumSq = 0;
            let count = 0;
            const step = 32;
            for (let i = 0; i < pixels.length; i += step * 4) {
              const r = pixels[i];
              const g = pixels[i + 1];
              const b = pixels[i + 2];
              const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
              sum += luma;
              sumSq += luma * luma;
              count += 1;
            }
            if (count > 0) {
              const mean = sum / count;
              const variance = sumSq / count - mean * mean;
              const std = Math.sqrt(Math.max(0, variance));
              if (mean < 45 || mean > 210 || std < 18) {
                setCameraQuality('Poor');
              } else if (mean < 70 || mean > 195 || std < 32) {
                setCameraQuality('Okay');
              } else {
                setCameraQuality('Good');
              }
            }
          }

          const jpegQuality = highAccuracyMode ? 0.92 : 0.85;
          const blob: Blob | null = await new Promise((resolve) =>
            captureCanvas.toBlob(resolve, 'image/jpeg', jpegQuality)
          );
          if (!blob) continue;

          const handForm = new FormData();
          handForm.append('image', blob, 'frame.jpg');
          const peopleForm = new FormData();
          peopleForm.append('image', blob, 'frame.jpg');

          const handConfidence = Math.round(handModelConfidence * 100);
          const overlap = Math.round(modelOverlap * 100);
          const handUrl = `${apiBaseUrl}/infer/hand-gestures?confidence=${handConfidence}&overlap=${overlap}`;
          const handRes = await fetch(handUrl, { method: 'POST', body: handForm });
          const handData = await handRes.json();
          const peopleUrl = `${apiBaseUrl}/infer/people?confidence=${handConfidence}&overlap=${overlap}&line_y=${PEOPLE_LINE_Y}`;
          const peopleRes = await fetch(peopleUrl, { method: 'POST', body: peopleForm });
          const peopleData = await peopleRes.json();
          const handPredictions = handData.predictions || [];
          const peoplePredictions = peopleData.predictions || [];

          const scaleX = video.videoWidth / captureCanvas.width;
          const scaleY = video.videoHeight / captureCanvas.height;

          if (camera.id === activeCameraId) {
            setHandDetections(
              handPredictions.map((pred: any) => ({
                x: pred.x * scaleX,
                y: pred.y * scaleY,
                width: pred.width * scaleX,
                height: pred.height * scaleY,
                label: pred.class || pred.class_name || pred.name || 'Unknown',
                confidence: pred.confidence || 0,
              }))
            );
            setPeopleDetections(
              peoplePredictions.map((pred: any) => ({
                id: pred.id ?? 0,
                x: pred.x * scaleX,
                y: pred.y * scaleY,
                width: pred.width * scaleX,
                height: pred.height * scaleY,
                confidence: pred.confidence || 0,
              }))
            );
          }

          totalPeople += peopleData.count ?? peoplePredictions.length ?? 0;

          const threshold = handGestureThreshold;
          const directGestureConfidence = handPredictions.reduce((max: number, pred: any) => {
            const label = (pred.class || pred.class_name || pred.name || '').toLowerCase();
            if (!HAND_GESTURE_CLASSES.has(label)) return max;
            return Math.max(max, pred.confidence || 0);
          }, 0);

          const cameraZones = zonesByCamera.get(camera.id) ?? [];
          let hasZoneAssist = false;
          cameraZones.forEach((zone) => {
            const rectPx = {
              x: zone.rect.x * video.videoWidth,
              y: zone.rect.y * video.videoHeight,
              w: zone.rect.w * video.videoWidth,
              h: zone.rect.h * video.videoHeight,
            };
            if (zone.type === 'Table') {
              const handMatches = handPredictions.filter((pred: any) => {
                const cx = pred.x * scaleX;
                const cy = pred.y * scaleY;
                const label = (pred.class || pred.class_name || pred.name || '').toLowerCase();
                return (
                  HAND_GESTURE_CLASSES.has(label) &&
                  cx >= rectPx.x &&
                  cx <= rectPx.x + rectPx.w &&
                  cy >= rectPx.y &&
                  cy <= rectPx.y + rectPx.h
                );
              });
              const handConfidence =
                handMatches.reduce((sum: number, pred: any) => sum + pred.confidence, 0) /
                (handMatches.length || 1);
              if (handConfidence >= threshold) {
                hasZoneAssist = true;
                nextAssistance.push({
                  zoneName: zone.name,
                  cameraLabel: camera.label,
                  cameraId: camera.id,
                });
              }
            }
            if (zone.type === 'Door') {
              const doorHit = peoplePredictions.some((pred: any) => {
                const cx = pred.x * scaleX;
                const cy = pred.y * scaleY;
                return (
                  cx >= rectPx.x &&
                  cx <= rectPx.x + rectPx.w &&
                  cy >= rectPx.y &&
                  cy <= rectPx.y + rectPx.h
                );
              });
              if (doorHit) {
                nextDoorZones.push({
                  zoneName: zone.name,
                  cameraLabel: camera.label,
                  cameraId: camera.id,
                });
              }
            }
          });

          if (directGestureConfidence >= threshold && !hasZoneAssist) {
            nextUnzoned.push(camera.label);
          }

          handPredictions.forEach((pred: any) => {
            const label = (pred.class || pred.class_name || pred.name || '').toLowerCase();
            if (!PERSON_GESTURE_CLASSES.has(label) || (pred.confidence || 0) < threshold)
              return;
            const handX = pred.x * scaleX;
            const handY = pred.y * scaleY;
            peoplePredictions.forEach((person: any, index: number) => {
              const px = person.x * scaleX;
              const py = person.y * scaleY;
              const pw = person.width * scaleX;
              const ph = person.height * scaleY;
              if (
                handX >= px - pw / 2 &&
                handX <= px + pw / 2 &&
                handY >= py - ph / 2 &&
                handY <= py + ph / 2
              ) {
                const personId = person.id ?? index + 1;
                personHits.add(`Person ${personId} (${camera.label})`);
              }
            });
          });

          const now = Date.now();
          const lastSeenAt = lastSeenRef.current[camera.id] ?? 0;
          if (now - lastSeenAt > 15000 && auth.currentUser) {
            lastSeenRef.current[camera.id] = now;
            void setDoc(
              doc(db, 'users', auth.currentUser.uid, 'cameras', camera.id),
              { lastSeen: serverTimestamp() },
              { merge: true }
            );
          }
        }

        setAssistanceZones(nextAssistance);
        setDoorZonesDetected(nextDoorZones);
        setUnzonedAssistance(nextUnzoned);
        setPersonAssistance(Array.from(personHits));
        setPeopleCount(totalPeople);
      } catch (err) {
        setError('Inference failed. Check backend connection.');
      } finally {
        inferenceInFlight.current = false;
      }
    }, 1800);

    return () => {
      clearInterval(interval);
      isActive = false;
    };
  }, [
    apiBaseUrl,
    availableDeviceSet,
    cameras,
    activeCameraId,
    handGestureThreshold,
    handModelConfidence,
    modelOverlap,
    highAccuracyMode,
    zonesByCamera,
  ]);

  useEffect(() => {
    if (!ownerRoom || !user) return;
    if (assistanceZones.length === 0 && doorZonesDetected.length === 0) {
      if (lastAlertRef.current) {
        lastAlertRef.current = '';
        void updateDoc(doc(db, 'rooms', ownerRoom.id), {
          latestAlert: null,
          latestAlertAt: serverTimestamp(),
        });
      }
      return;
    }
    const messages: string[] = [];
    if (assistanceZones.length > 0) {
      messages.push(
        `${profile?.messages?.assistance || 'Customer Assistance Needed'} in ${assistanceZones
          .map((zone) => zone.zoneName)
          .join(', ')}`
      );
    }
    if (doorZonesDetected.length > 0) {
      messages.push(
        `${profile?.messages?.door || 'Customer entered the restaurant'} in ${doorZonesDetected
          .map((zone) => zone.zoneName)
          .join(', ')}`
      );
    }
    const message = messages.join(' • ');
    if (message === lastAlertRef.current) return;
    lastAlertRef.current = message;
    void updateDoc(doc(db, 'rooms', ownerRoom.id), {
      latestAlert: message,
      latestAlertAt: serverTimestamp(),
    });
  }, [
    assistanceZones,
    doorZonesDetected,
    ownerRoom,
    profile?.messages?.assistance,
    profile?.messages?.door,
    user,
  ]);

  useEffect(() => {
    if (assistanceZones.length === 0) {
      setOverlayDismissed(false);
      setLastAlertKey('');
      return;
    }
    const alertKey = assistanceZones
      .map((zone) => `${zone.cameraId}:${zone.zoneName}`)
      .sort()
      .join('|');
    if (alertKey !== lastAlertKey) {
      setLastAlertKey(alertKey);
      setOverlayDismissed(false);
    }
  }, [assistanceZones, lastAlertKey]);

  useEffect(() => {
    if (doorZonesDetected.length === 0) {
      setDoorOverlayDismissed(false);
      doorActiveRef.current = false;
      return;
    }
    if (!doorActiveRef.current && Date.now() >= doorCooldownUntil) {
      doorActiveRef.current = true;
      setDoorOverlayDismissed(false);
      const cooldownUntil = Date.now() + 2000;
      setDoorCooldownUntil(cooldownUntil);
      if (doorTimeoutRef.current) {
        window.clearTimeout(doorTimeoutRef.current);
      }
      doorTimeoutRef.current = window.setTimeout(() => {
        setDoorOverlayDismissed(true);
      }, 2000);
    }
  }, [doorZonesDetected, doorCooldownUntil]);

  const handleThresholdSave = async () => {
    if (!auth.currentUser) return;
    setThresholdStatus('Saving...');
    try {
      await updateDoc(doc(db, 'users', auth.currentUser.uid), {
        flashNotifications,
      });
      setThresholdStatus('Saved.');
    } catch (err) {
      setThresholdStatus('Save failed.');
    }
  };

  const handleTestNotification = () => {
    const baseMessage = profile?.messages?.assistance || 'Customer Assistance Needed';
    const zoneLabel = assistanceZones.length
      ? ` in ${assistanceZones.map((zone) => `${zone.zoneName} (${zone.cameraLabel})`).join(', ')}`
      : '';
    const message = `${baseMessage}${zoneLabel}`;
    const fullMessage = zoneLabel ? message : `${message}\nNo Table was found`;
    triggerOverlay(fullMessage, 'Test Notification', 3500);
  };

  const formatDuration = (startAt?: Timestamp | null) => {
    if (!startAt) return '0:00';
    const ms = Math.max(0, now - startAt.toDate().getTime());
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const [partyZone, setPartyZone] = useState<Zone | null>(null);

  const handleStartDineIn = (zone: Zone) => {
    setPartyZone(zone);
  };

  const handleConfirmPartySize = async (size: number) => {
    if (!auth.currentUser || !partyZone) return;
    await updateDoc(doc(db, 'users', auth.currentUser.uid, 'zones', partyZone.id), {
      dineInActive: true,
      dineInStartedAt: serverTimestamp(),
      dineInPartySize: size,
    });
    setPartyZone(null);
  };

  const handleStopDineIn = async (zone: Zone) => {
    if (!auth.currentUser) return;
    await updateDoc(doc(db, 'users', auth.currentUser.uid, 'zones', zone.id), {
      dineInActive: false,
      dineInStartedAt: null,
    });
  };

  return (
    <div className={`idle ${embedded ? 'idle-embedded' : ''}`}>
      {flashNotifications && assistanceZones.length > 0 && !overlayDismissed ? (
        <div className="idle-live-overlay" role="alert">
          <div className="idle-live-content">
            <div className="idle-live-title">
              {profile?.messages?.assistance || 'Customer Assistance Needed'}
            </div>
            <div className="idle-live-bubbles">
              {assistanceZones.map((zone) => (
                <span key={`${zone.cameraId}-${zone.zoneName}`}>
                  {zone.zoneName} • {zone.cameraLabel}
                </span>
              ))}
            </div>
            <button type="button" onClick={() => setOverlayDismissed(true)}>
              Understood!
            </button>
          </div>
        </div>
      ) : null}
      {flashNotifications &&
      doorZonesDetected.length > 0 &&
      (assistanceZones.length === 0 || overlayDismissed) &&
      !doorOverlayDismissed &&
      Date.now() >= doorCooldownUntil ? (
        <div className="idle-door-overlay" role="alert">
          <div className="idle-live-content">
            <div className="idle-live-title">
              {profile?.messages?.door || 'Customer entered the restaurant'}
            </div>
            <div className="idle-live-bubbles">
              {doorZonesDetected.map((zone) => (
                <span key={`${zone.cameraId}-${zone.zoneName}`}>
                  {zone.zoneName} • {zone.cameraLabel}
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setDoorOverlayDismissed(true);
                setDoorCooldownUntil(Date.now() + 2000);
                doorActiveRef.current = false;
              }}
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}
      {testNotification.active ? (
        <div className="idle-test-overlay" role="alert">
          <div className="idle-test-text">{testNotification.message}</div>
          <div className="idle-test-sub">{testNotification.subtitle}</div>
        </div>
      ) : null}
      {!embedded ? (
        <header className="idle-header">
          <Link to="/zones">Back to Zones</Link>
          <div className="idle-title">
            <img src={TableMateLogo} alt="TableMate logo" />
            <span>Idle Mode</span>
          </div>
          <Link to="/room">Room</Link>
        </header>
      ) : null}
      {!profile?.cameraSetup ? (
        <div className="idle-warning">
          Camera setup is required before Idle Mode. Go to Settings or Camera Setup.
        </div>
      ) : null}

      <div className="idle-nav">
        {(['camera', 'alerts', 'settings', 'management', 'all'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={viewMode === mode ? 'active' : ''}
            onClick={() => setViewMode(mode)}
          >
            {mode === 'all'
              ? 'All'
              : mode === 'management'
                ? 'Tables'
                : mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>

      <div className={`idle-grid ${viewMode === 'all' ? '' : 'idle-grid-single'}`}>
        {(viewMode === 'all' || viewMode === 'camera') && (
          <div className="idle-camera">
            {cameras.length > 1 ? (
              <div className="idle-camera-tabs">
                <div className="idle-camera-tablist">
                  {cameras.map((camera, index) => (
                    <button
                      key={camera.id}
                      type="button"
                      className={camera.id === activeCamera?.id ? 'active' : ''}
                      onClick={() => setActiveCameraId(camera.id)}
                    >
                      {camera.label || `Cam ${index + 1}`}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="idle-camera-toggle"
                  onClick={() => setShowAllCameras((prev) => !prev)}
                >
                  {showAllCameras ? 'Show one' : 'Show all'}
                </button>
              </div>
            ) : null}
            {displayCameras.length === 0 ? (
              <div className="idle-warning">No cameras connected yet.</div>
            ) : (
              <div
                className={`idle-camera-grid ${
                  showAllCameras ? 'idle-camera-grid-multi' : ''
                }`}
              >
                {displayCameras.map((camera, index) => {
                  const isMissing =
                    camera.deviceId && !availableDeviceSet.has(camera.deviceId);
                  return (
                    <div
                      key={camera.id}
                      className={`idle-preview ${isMissing ? 'disconnected' : ''}`}
                    >
                      <div className="idle-preview-label">
                        {camera.label || `Cam ${index + 1}`}
                      </div>
                      <video
                        ref={(el) => {
                          if (el) {
                            videoRefs.current[camera.id] = el;
                            const stream = streamRefs.current[camera.id];
                            if (stream) {
                              attachStreamToVideo(camera.id, stream);
                            }
                          }
                          if (camera.id === activeCamera?.id) {
                            videoRef.current = el;
                          }
                        }}
                        autoPlay
                        playsInline
                        muted
                      />
                      {camera.id === activeCamera?.id ? <canvas ref={canvasRef} /> : null}
                      {isMissing ? (
                        <div className="idle-preview-overlay">
                          Camera has been disconnected
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="idle-camera-meta">
              Active camera quality:{' '}
              <span className={`idle-quality idle-quality-${cameraQuality.toLowerCase()}`}>
                {cameraQuality}
              </span>
            </div>
          </div>
        )}

        {(viewMode === 'all' || viewMode === 'alerts' || viewMode === 'settings') && (
          <div className="idle-info">
            {(viewMode === 'all' || viewMode === 'alerts') && (
              <div className="idle-people-card">
                <div className="idle-people-title">People Counter</div>
                <div className="idle-people-count">{peopleCount}</div>
                <div className="idle-people-divider" />
                <div className="idle-people-notifications">
                  <h2>Notifications</h2>
                  {assistanceZones.length ? (
                    <div className="idle-warning">
                      {assistanceZones.map((zone) => (
                        <span key={`${zone.cameraId}-${zone.zoneName}`}>
                          {profile?.messages?.assistance || 'Customer Assistance Needed'} in{' '}
                          {zone.zoneName} ({zone.cameraLabel})
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {doorZonesDetected.length ? (
                    <div className="idle-warning">
                      {doorZonesDetected.map((zone) => (
                        <span key={`${zone.cameraId}-${zone.zoneName}`}>
                          {profile?.messages?.door || 'Customer entered the restaurant'} in{' '}
                          {zone.zoneName} ({zone.cameraLabel})
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {!assistanceZones.length && !doorZonesDetected.length && unzonedAssistance.length ? (
                    <div className="idle-warning">
                      {profile?.messages?.assistance || 'Customer Assistance Needed'} — No table
                      zone found ({unzonedAssistance.join(', ')}).
                    </div>
                  ) : null}
                  {!assistanceZones.length && !doorZonesDetected.length && !unzonedAssistance.length ? (
                    <div className="idle-ok">No active alerts.</div>
                  ) : null}
                  {activeSessions.length ? (
                    <div className="idle-warning">
                      <h4>Ongoing dine-in sessions</h4>
                      {activeSessions.map((zone) => (
                        <div key={zone.id} className="idle-session-row">
                          <span>
                            {zone.name} ·{' '}
                            {cameraLabelMap.get(zone.cameraId || '') || 'Unassigned'} ·{' '}
                            {formatDuration(zone.dineInStartedAt)}
                          </span>
                          <button type="button" onClick={() => handleStopDineIn(zone)}>
                            Stop
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {personAssistance.length ? (
                    <div className="idle-warning">
                      {personAssistance.map((person) => (
                        <span key={person}>{person} needs assistance.</span>
                      ))}
                    </div>
                  ) : null}
                  {error ? <div className="idle-error">{error}</div> : null}
                </div>
              </div>
            )}
            {(viewMode === 'all' || viewMode === 'settings') && (
              <div className="idle-settings">
                <h3>Alerts</h3>
                <div className="idle-toggle">
                  <label htmlFor="flash-notifications">Flash full-screen alerts</label>
                  <input
                    id="flash-notifications"
                    type="checkbox"
                    checked={flashNotifications}
                    onChange={(event) => setFlashNotifications(event.target.checked)}
                  />
                </div>
                <div className="idle-threshold-actions">
                  <button type="button" onClick={handleThresholdSave}>
                    Save alert settings
                  </button>
                  {thresholdStatus ? <span>{thresholdStatus}</span> : null}
                </div>
                <div className="idle-threshold-actions">
                  <button type="button" onClick={handleTestNotification}>
                    Test notification
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {viewMode === 'management' ? (
          <div className="idle-management">
            <div className="idle-management-header">
              <div>
                <h2>Table Management</h2>
                <p>
                  Use this mode to track dine-in duration per table. Start a timer when guests
                  are seated and stop it when they leave.
                </p>
                <span className="idle-management-sub">
                  Timers are saved per camera. Rename cameras for clearer sections.
                </span>
              </div>
            </div>
            <div className="idle-management-layout">
              <aside className="idle-management-sidebar">
                <h3>Cameras</h3>
                <div className="idle-management-tabs">
                  {cameras.map((camera, index) => (
                    <button
                      key={camera.id}
                      type="button"
                      className={camera.id === managementCamera?.id ? 'active' : ''}
                      onClick={() => setManagementCameraId(camera.id)}
                    >
                      {camera.label || `Dining Room ${index + 1}`}
                    </button>
                  ))}
                </div>
              </aside>
              <div className="idle-management-map">
                {managementCamera ? (
                  <>
                    <div className="idle-camera-group-title">
                      {cameraLabelMap.get(managementCamera.id) || 'Dining Room'}
                    </div>
                    {managementZones.length === 0 ? (
                      <div className="idle-warning">No table zones on this camera yet.</div>
                    ) : (
                      <div className="idle-management-grid">
                        {managementZones.map((zone) => (
                          <div
                            key={zone.id}
                            className={`idle-management-card ${zone.dineInActive ? 'active' : ''}`}
                          >
                            <div className="idle-map-name">{zone.name}</div>
                            <div className="idle-map-time">
                              {zone.dineInActive ? formatDuration(zone.dineInStartedAt) : '0:00'}
                            </div>
                            {zone.dineInPartySize ? (
                              <div className="idle-map-party">Party {zone.dineInPartySize}</div>
                            ) : null}
                            <button
                              type="button"
                              onClick={() =>
                                zone.dineInActive ? handleStopDineIn(zone) : handleStartDineIn(zone)
                              }
                            >
                              {zone.dineInActive ? 'Stop' : 'Start Dine-In'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="idle-warning">No cameras available.</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {partyZone ? (
        <div className="idle-party-overlay">
          <div className="idle-party-card">
            <h3>Party size for {partyZone.name}</h3>
            <p>Select the number of guests seated at this table.</p>
            <div className="idle-party-grid">
              {Array.from({ length: 10 }).map((_, index) => (
                <button
                  key={`party-${index + 1}`}
                  type="button"
                  onClick={() => handleConfirmPartySize(index + 1)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
            <button type="button" className="idle-party-cancel" onClick={() => setPartyZone(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {!embedded ? <Footer /> : null}
    </div>
  );
};

export default IdleMode;
