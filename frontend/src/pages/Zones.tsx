import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth, db } from '../firebase';
import useOwnerRoom from '../hooks/useOwnerRoom';
import useUserProfile from '../hooks/useUserProfile';
import './Zones.css';
import TableMateLogo from '../TableMateAssets/TableMateLogoOfficial.png';
import Footer from '../components/Footer';

type CameraDevice = MediaDeviceInfo;
type ZoneType = 'Table' | 'Door';
type UserCamera = {
  id: string;
  deviceId: string;
  label: string;
  createdAt?: Timestamp;
  lastSeen?: Timestamp;
};

type ZoneRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

const HAND_GESTURE_CLASSES = new Set(['stop', 'palm', 'raised', 'three2', 'three3']);
const HAND_Y_MAX = 100;

type Zone = {
  id: string;
  name: string;
  type: ZoneType;
  rect: ZoneRect;
  deviceName: string;
  cameraId?: string;
  color?: string | null;
};

const Home: React.FC = () => {
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [newCameraDeviceId, setNewCameraDeviceId] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [status, setStatus] = useState<string>('Camera is idle.');
  const [isRequesting, setIsRequesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'Good' | 'Bad' | 'Idle'>('Idle');
  const [zones, setZones] = useState<Zone[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [draftZone, setDraftZone] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null
  );
  const [zoneType, setZoneType] = useState<ZoneType>('Table');
  const [zoneName, setZoneName] = useState('');
  const [zoneColor, setZoneColor] = useState('#2b3a67');
  const [zoneError, setZoneError] = useState('');
  const [addingZone, setAddingZone] = useState(false);
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [showZoneBuilder, setShowZoneBuilder] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; zoneId: string } | null>(
    null
  );
  const [zoneMetrics, setZoneMetrics] = useState<Record<string, { handConfidence: number }>>({});
  const [handDetections, setHandDetections] = useState<
    { x: number; y: number; width: number; height: number; label: string; confidence: number }[]
  >([]);
  const [peopleDetections, setPeopleDetections] = useState<
    { id: number; x: number; y: number; width: number; height: number; confidence: number }[]
  >([]);
  const [assistanceZones, setAssistanceZones] = useState<string[]>([]);
  const [deviceWarning, setDeviceWarning] = useState('');
  const [cameraStatus, setCameraStatus] = useState('');
  const [cameraStatusTone, setCameraStatusTone] = useState<'warning' | 'error' | 'success'>(
    'warning'
  );
  const [cameras, setCameras] = useState<UserCamera[]>([]);
  const [activeCameraId, setActiveCameraId] = useState<string>('');
  const [editingCameraId, setEditingCameraId] = useState<string | null>(null);
  const [editingCameraLabel, setEditingCameraLabel] = useState('');
  const lastAlertRef = useRef<string>('');
  const lastMainCameraStatusRef = useRef<'active' | 'disabled' | ''>('');
  const inferenceInFlight = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const hasDevices = devices.length > 0;
  const activeCamera = useMemo(
    () => cameras.find((camera) => camera.id === activeCameraId) || cameras[0],
    [cameras, activeCameraId]
  );
  const activeDevice = useMemo(
    () => devices.find((device) => device.deviceId === selectedDeviceId),
    [devices, selectedDeviceId]
  );
  const activeDeviceName = activeCamera?.label || activeDevice?.label || 'Unknown camera';
  const deviceAvailability = useMemo(
    () => new Set(devices.map((device) => device.deviceId)),
    [devices]
  );
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5050';
  const { profile, user } = useUserProfile();
  const ownerRoom = useOwnerRoom(user?.uid);
  const isActiveCameraMissing = Boolean(
    activeCamera?.deviceId && !deviceAvailability.has(activeCamera.deviceId)
  );
  const visibleZones = useMemo(() => {
    if (!activeCameraId) return zones;
    return zones.filter((zone) => {
      if (!zone.cameraId) {
        return cameras.length <= 1;
      }
      return zone.cameraId === activeCameraId;
    });
  }, [zones, activeCameraId, cameras.length]);

  const isZoneNameTaken = (name: string, excludeId?: string | null) => {
    const normalized = name.trim().toLowerCase();
    return zones.some((zone) => {
      if (excludeId && zone.id === excludeId) return false;
      return zone.name.trim().toLowerCase() === normalized;
    });
  };

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const startStream = async (deviceId?: string) => {
    setIsRequesting(true);
    setError('');

    try {
      stopStream();
      const constraints: MediaStreamConstraints = {
        video: deviceId ? { deviceId: { ideal: deviceId } } : true,
        audio: false,
      };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        const isInvalid =
          err instanceof DOMException && err.name === 'OverconstrainedError';
        if (isInvalid) {
          setError('Camera has been disconnected!');
          setStatus('Camera disconnected.');
          setConnectionStatus('Bad');
          return;
        } else {
          throw err;
        }
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setStatus('Camera is live.');
      setConnectionStatus('Good');
      if (activeCamera?.deviceId && deviceId && activeCamera.deviceId !== deviceId) {
        setDeviceWarning(
          'This does not match your saved camera. Use the original device or re-setup your camera.'
        );
      } else {
        setDeviceWarning('');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to access camera.';
      setError(message);
      setStatus('Camera access blocked.');
      setConnectionStatus('Bad');
    } finally {
      setIsRequesting(false);
    }
  };

  const refreshDevices = async () => {
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = allDevices.filter((device) => device.kind === 'videoinput');
    setDevices(videoDevices);
    if (videoDevices.length && !newCameraDeviceId) {
      setNewCameraDeviceId(videoDevices[0].deviceId);
    }
  };

  const handleEnableCamera = async () => {
    await startStream(activeCamera?.deviceId || undefined);
    await refreshDevices();
  };

  const handleUseSavedDevice = async () => {
    if (activeCamera?.deviceId) {
      setSelectedDeviceId(activeCamera.deviceId);
      await startStream(activeCamera.deviceId);
    }
  };

  const autoStartCamera = async () => {
    await refreshDevices();
    await startStream(activeCamera?.deviceId || undefined);
  };

  const handleDeviceChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const deviceId = event.target.value;
    setNewCameraDeviceId(deviceId);
  };

  const handleCameraSelect = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const cameraId = event.target.value;
    setActiveCameraId(cameraId);
    setCameraStatus('');
  };

  const handleRenameCamera = async (cameraId: string) => {
    if (!auth.currentUser) return;
    const trimmed = editingCameraLabel.trim();
    if (!trimmed) {
      setCameraStatus('Camera name cannot be empty.');
      setCameraStatusTone('warning');
      return;
    }
    await updateDoc(doc(db, 'users', auth.currentUser.uid, 'cameras', cameraId), {
      label: trimmed,
    });
    setEditingCameraId(null);
    setEditingCameraLabel('');
  };

  useEffect(() => {
    setZoneColor(defaultZoneColor(zoneType));
  }, [zoneType]);

  const planMax = profile?.plan === 'plus' ? 8 : 3;
  const maxCameras = Math.max(profile?.maxCameras ?? 0, planMax);
  const canAddCamera = cameras.length < maxCameras;
  const isPlusPlan = profile?.plan === 'plus';
  const defaultZoneColor = (type: ZoneType) => (type === 'Table' ? '#2b3a67' : '#e17b4f');

  const handleAddCamera = async () => {
    if (!auth.currentUser) return;
    if (!newCameraDeviceId) return;
    if (!canAddCamera) {
      setCameraStatus(
        'TableMate+ required to add more cameras. Existing cameras stay active.'
      );
      setCameraStatusTone('warning');
      return;
    }
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = allDevices.filter((item) => item.kind === 'videoinput');
      setDevices(videoDevices);
      const device = videoDevices.find((item) => item.deviceId === newCameraDeviceId);
      if (!device) {
        setCameraStatus('Selected camera not available. Try refresh.');
        setCameraStatusTone('warning');
        return;
      }
      setCameraStatus('');
      const camerasRef = collection(db, 'users', auth.currentUser.uid, 'cameras');
      const existing = cameras.find((camera) => camera.deviceId === device.deviceId);
      if (existing) {
        setCameraStatus('This camera is already saved.');
        setCameraStatusTone('warning');
        return;
      }
      const created = await addDoc(camerasRef, {
        deviceId: device.deviceId,
        label: device.label || 'Camera',
        createdAt: serverTimestamp(),
      });
      const updates: Record<string, string | boolean | null> = {
        cameraSetup: true,
      };
      if (!profile?.primaryCameraId) {
        updates.primaryCameraId = created.id;
        updates.cameraDeviceId = device.deviceId;
        updates.cameraDeviceLabel = device.label || 'Camera';
      }
      await updateDoc(doc(db, 'users', auth.currentUser.uid), updates);
      setCameraStatus('Camera added. Switch active camera to configure zones.');
      setCameraStatusTone('success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to add camera.';
      setCameraStatus(message);
      setCameraStatusTone('error');
    }
  };

  const handleRemoveCamera = async (cameraId: string) => {
    if (!auth.currentUser) return;
    if (cameras.length <= 1) {
      setCameraStatus('At least one camera is required.');
      setCameraStatusTone('warning');
      return;
    }
    const confirmed = window.confirm('Remove this camera and delete its zones?');
    if (!confirmed) return;
    const batch = writeBatch(db);
    const zonesRef = collection(db, 'users', auth.currentUser.uid, 'zones');
    const zonesSnap = await getDocs(zonesRef);
    zonesSnap.docs.forEach((docSnap) => {
      if ((docSnap.data() as Zone).cameraId === cameraId) {
        batch.delete(docSnap.ref);
      }
    });
    batch.delete(doc(db, 'users', auth.currentUser.uid, 'cameras', cameraId));
    await batch.commit();
    setCameraStatus('Camera removed.');
    setCameraStatusTone('error');
    await refreshDevices();
    const remaining = cameras.filter((camera) => camera.id !== cameraId);
    if (remaining.length === 0) {
      await updateDoc(doc(db, 'users', auth.currentUser.uid), {
        primaryCameraId: null,
        cameraSetup: false,
      });
      setActiveCameraId('');
      return;
    }
    if (profile?.primaryCameraId === cameraId) {
      const nextPrimary = remaining[0];
      await updateDoc(doc(db, 'users', auth.currentUser.uid), {
        primaryCameraId: nextPrimary.id,
        cameraDeviceId: nextPrimary.deviceId,
        cameraDeviceLabel: nextPrimary.label,
      });
      setActiveCameraId(nextPrimary.id);
    }
  };

  useEffect(() => {
    refreshDevices();
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleDeviceChange = () => {
      void refreshDevices();
    };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, []);

  useEffect(() => {
    if (!activeCamera?.deviceId) return;
    if (!deviceAvailability.has(activeCamera.deviceId)) {
      setError('Camera has been disconnected!');
      setStatus('Camera disconnected.');
      setConnectionStatus('Bad');
      stopStream();
    }
  }, [activeCamera?.deviceId, deviceAvailability]);

  useEffect(() => {
    if (!user) return;
    const camerasRef = collection(db, 'users', user.uid, 'cameras');
    const camerasQuery = query(camerasRef, orderBy('createdAt', 'asc'));
    const unsubscribe = onSnapshot(camerasQuery, (snapshot) => {
      const nextCameras = snapshot.docs.map((docSnap) => {
        const data = docSnap.data() as UserCamera;
        return {
          id: docSnap.id,
          deviceId: data.deviceId,
          label: data.label,
          createdAt: data.createdAt,
          lastSeen: data.lastSeen,
        };
      });
      setCameras(nextCameras);
      if (!activeCameraId) {
        const primary = nextCameras.find((camera) => camera.id === profile?.primaryCameraId);
        const nextActive = primary?.id || nextCameras[0]?.id || '';
        setActiveCameraId(nextActive);
      }
    });
    return () => unsubscribe();
  }, [user, activeCameraId, profile?.primaryCameraId]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void autoStartCamera();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCamera?.deviceId]);

  useEffect(() => {
    if (!activeCamera?.deviceId) return;
    setSelectedDeviceId(activeCamera.deviceId);
    void startStream(activeCamera.deviceId);
  }, [activeCamera?.deviceId]);

  useEffect(() => {
  }, [activeCameraId]);

  useEffect(() => {
    if (!auth.currentUser || !activeCamera?.id) return;
    if (connectionStatus !== 'Good') return;
    const cameraRef = doc(db, 'users', auth.currentUser.uid, 'cameras', activeCamera.id);
    const interval = setInterval(() => {
      void setDoc(cameraRef, { lastSeen: serverTimestamp() }, { merge: true });
    }, 15000);
    void setDoc(cameraRef, { lastSeen: serverTimestamp() }, { merge: true });
    return () => clearInterval(interval);
  }, [activeCamera?.id, connectionStatus]);

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
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawnZones = editingZoneId
      ? visibleZones.filter((zone) => zone.id === editingZoneId)
      : visibleZones;

    drawnZones.forEach((zone) => {
      const x = zone.rect.x * canvas.width;
      const y = zone.rect.y * canvas.height;
      const w = zone.rect.w * canvas.width;
      const h = zone.rect.h * canvas.height;
      ctx.strokeStyle = zone.color || defaultZoneColor(zone.type);
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(x, y - 22, 130, 20);
      ctx.fillStyle = '#fff';
      ctx.font = '12px Sora, sans-serif';
      ctx.fillText(`${zone.name} • ${zone.type}`, x + 6, y - 7);
    });

    if (draftZone) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(draftZone.x, draftZone.y, draftZone.w, draftZone.h);
      ctx.setLineDash([]);
    }

    const video = videoRef.current;
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
  }, [visibleZones, draftZone, handDetections, peopleDetections, editingZoneId]);

  const toCanvasPoint = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const rectsOverlap = (a: ZoneRect, b: ZoneRect) => {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  };

  const handleCanvasMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!addingZone) return;
    const { x, y } = toCanvasPoint(event);
    setIsDrawing(true);
    setDraftZone({ x, y, w: 0, h: 0 });
  };

  const handleCanvasMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !draftZone) return;
    const { x, y } = toCanvasPoint(event);
    setDraftZone({ ...draftZone, w: x - draftZone.x, h: y - draftZone.y });
  };

  const handleCanvasMouseUp = () => {
    if (!isDrawing || !draftZone) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const normalized = {
      x: Math.min(draftZone.x, draftZone.x + draftZone.w) / canvas.width,
      y: Math.min(draftZone.y, draftZone.y + draftZone.h) / canvas.height,
      w: Math.abs(draftZone.w) / canvas.width,
      h: Math.abs(draftZone.h) / canvas.height,
    };
    setZoneError('');

    if (normalized.w < 0.04 || normalized.h < 0.04) {
      setZoneError('Zone is too small. Please draw a larger box.');
      setDraftZone(null);
      setIsDrawing(false);
      setAddingZone(false);
      return;
    }

    if (!zoneName.trim()) {
      setZoneError('Please name the zone before saving.');
      setDraftZone(null);
      setIsDrawing(false);
      setAddingZone(false);
      return;
    }

    if (isZoneNameTaken(zoneName.trim(), editingZoneId)) {
      setZoneError('Zone names must be unique across all cameras.');
      setDraftZone(null);
      setIsDrawing(false);
      setAddingZone(false);
      return;
    }

    const hasOverlap = visibleZones.some((zone) => {
      if (editingZoneId && zone.id === editingZoneId) return false;
      return rectsOverlap(zone.rect, normalized);
    });

    if (hasOverlap) {
      setZoneError('Zones cannot overlap. Please redraw the zone.');
      setDraftZone(null);
      setIsDrawing(false);
      setAddingZone(false);
      return;
    }

    if (editingZoneId) {
      void updateDoc(doc(db, 'users', auth.currentUser!.uid, 'zones', editingZoneId), {
        rect: normalized,
        color: isPlusPlan ? zoneColor : null,
      });
      setEditingZoneId(null);
    } else {
      void addDoc(collection(db, 'users', auth.currentUser!.uid, 'zones'), {
        name: zoneName.trim(),
        type: zoneType,
        rect: normalized,
        deviceName: activeDeviceName,
        cameraId: activeCameraId || null,
        color: isPlusPlan ? zoneColor : null,
        createdAt: serverTimestamp(),
      });
    }
    setDraftZone(null);
    setIsDrawing(false);
    setAddingZone(false);
    setZoneName('');
  };

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
          deviceName: data.deviceName,
          cameraId: data.cameraId,
          color: data.color ?? null,
        };
      });
      setZones(nextZones);
    });
    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (isPlusPlan) return;
    if (!auth.currentUser) return;
    const zonesWithColor = zones.filter((zone) => zone.color);
    if (zonesWithColor.length === 0) return;
    const batch = writeBatch(db);
    zonesWithColor.forEach((zone) => {
      batch.update(doc(db, 'users', auth.currentUser!.uid, 'zones', zone.id), {
        color: null,
      });
    });
    void batch.commit();
  }, [isPlusPlan, zones]);

  useEffect(() => {
    if (!user || !profile?.primaryCameraId) return;
    const legacyZones = zones.filter((zone) => !zone.cameraId);
    if (legacyZones.length === 0) return;
    legacyZones.forEach((zone) => {
      void updateDoc(doc(db, 'users', user.uid, 'zones', zone.id), {
        cameraId: profile.primaryCameraId,
      });
    });
  }, [user, profile?.primaryCameraId, zones]);

  useEffect(() => {
    const migrateLegacyCamera = async () => {
      if (!user || !profile?.cameraDeviceId) return;
      if (cameras.length > 0) return;
      const camerasRef = collection(db, 'users', user.uid, 'cameras');
      const existingQuery = query(camerasRef, where('deviceId', '==', profile.cameraDeviceId));
      const existingSnapshot = await getDocs(existingQuery);
      if (existingSnapshot.empty) {
        const created = await addDoc(camerasRef, {
          deviceId: profile.cameraDeviceId,
          label: profile.cameraDeviceLabel || 'Camera',
          createdAt: serverTimestamp(),
        });
        await updateDoc(doc(db, 'users', user.uid), {
          primaryCameraId: profile.primaryCameraId ?? created.id,
          cameraSetup: true,
        });
      } else if (!profile.primaryCameraId) {
        await updateDoc(doc(db, 'users', user.uid), {
          primaryCameraId: existingSnapshot.docs[0].id,
          cameraSetup: true,
        });
      }
    };
    void migrateLegacyCamera();
  }, [user, profile?.cameraDeviceId, profile?.cameraDeviceLabel, profile?.primaryCameraId, cameras.length]);

  useEffect(() => {
    if (connectionStatus !== 'Good' || visibleZones.length === 0) return;
    let isActive = true;
    const interval = setInterval(async () => {
      if (!isActive) return;
      if (inferenceInFlight.current) return;
      const video = videoRef.current;
      if (!video || video.videoWidth === 0) return;

      const captureCanvas = document.createElement('canvas');
      const maxWidth = profile?.highAccuracyMode ? 1280 : 640;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      captureCanvas.width = Math.round(video.videoWidth * scale);
      captureCanvas.height = Math.round(video.videoHeight * scale);
      const ctx = captureCanvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

      const jpegQuality = profile?.highAccuracyMode ? 0.92 : 0.85;
      const blob: Blob | null = await new Promise((resolve) =>
        captureCanvas.toBlob(resolve, 'image/jpeg', jpegQuality)
      );
      if (!blob) return;

      try {
        inferenceInFlight.current = true;
        const handForm = new FormData();
        handForm.append('image', blob, 'frame.jpg');
        const peopleForm = new FormData();
        peopleForm.append('image', blob, 'frame.jpg');

        const handConfidence = Math.round((profile?.handModelConfidence ?? 0.45) * 100);
        const overlap = Math.round((profile?.modelOverlap ?? 0.3) * 100);
        const handUrl = `${apiBaseUrl}/infer/hand-gestures?confidence=${handConfidence}&overlap=${overlap}`;
        const handRes = await fetch(handUrl, { method: 'POST', body: handForm });
        const handData = await handRes.json();
        const peopleUrl = `${apiBaseUrl}/infer/people?confidence=${handConfidence}&overlap=${overlap}&line_y=0.6`;
        const peopleRes = await fetch(peopleUrl, { method: 'POST', body: peopleForm });
        const peopleData = await peopleRes.json();
        const handPredictions = handData.predictions || [];
        const peoplePredictions = peopleData.predictions || [];

        const scaleX = video.videoWidth / captureCanvas.width;
        const scaleY = video.videoHeight / captureCanvas.height;

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

        const nextMetrics: Record<string, { handConfidence: number }> = {};
        const assistance: string[] = [];

        const threshold = profile?.handGestureThreshold ?? 0.45;

        visibleZones.forEach((zone) => {
          const rectPx = {
            x: zone.rect.x * video.videoWidth,
            y: zone.rect.y * video.videoHeight,
            w: zone.rect.w * video.videoWidth,
            h: zone.rect.h * video.videoHeight,
          };
          let handConfidence = 0;
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
            handConfidence =
              handMatches.reduce((sum: number, pred: any) => sum + pred.confidence, 0) /
              (handMatches.length || 1);
            if (handConfidence >= threshold) {
              assistance.push(zone.name);
            }
          }

          nextMetrics[zone.id] = { handConfidence };
        });

        setZoneMetrics(nextMetrics);
        setAssistanceZones(assistance);
      } catch (err) {
        setError('Inference failed. Check backend connection.');
      } finally {
        inferenceInFlight.current = false;
      }
    }, 1500);

    return () => {
      clearInterval(interval);
      isActive = false;
    };
  }, [
    apiBaseUrl,
    connectionStatus,
    profile?.handModelConfidence,
    profile?.modelOverlap,
    profile?.highAccuracyMode,
    visibleZones,
  ]);

  useEffect(() => {
    if (!ownerRoom || !user) return;
    if (assistanceZones.length === 0) {
      if (lastAlertRef.current) {
        lastAlertRef.current = '';
        void updateDoc(doc(db, 'rooms', ownerRoom.id), {
          latestAlert: null,
          latestAlertAt: serverTimestamp(),
        });
      }
      return;
    }
    const message = `${profile?.messages?.assistance || 'Customer Assistance Needed'} in ${assistanceZones.join(
      ', '
    )}`;
    if (message === lastAlertRef.current) return;
    lastAlertRef.current = message;
    void updateDoc(doc(db, 'rooms', ownerRoom.id), {
      latestAlert: message,
      latestAlertAt: serverTimestamp(),
    });
  }, [assistanceZones, ownerRoom, profile?.messages?.assistance, user]);

  const handleStartZone = () => {
    if (isActiveCameraMissing) {
      setZoneError('Reconnect the active camera before creating zones.');
      return;
    }
    setZoneError('');
    setAddingZone(true);
  };

  const handleEditZone = (zone: Zone) => {
    setEditingZoneId(zone.id);
    setZoneType(zone.type);
    setZoneName(zone.name);
    setZoneColor(zone.color || defaultZoneColor(zone.type));
    setAddingZone(true);
    setZoneError('');
  };

  const handleDeleteZone = async (zoneId: string) => {
    if (!auth.currentUser) return;
    await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'zones', zoneId));
    setContextMenu(null);
  };

  const handleZoneNameUpdate = async (zoneId: string, name: string) => {
    if (!auth.currentUser) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (isZoneNameTaken(trimmed, zoneId)) {
      setZoneError('Zone names must be unique across all cameras.');
      return;
    }
    await updateDoc(doc(db, 'users', auth.currentUser.uid, 'zones', zoneId), { name: trimmed });
    setZoneError('');
  };

  const handleZoneTypeUpdate = async (zoneId: string, type: ZoneType) => {
    if (!auth.currentUser) return;
    await updateDoc(doc(db, 'users', auth.currentUser.uid, 'zones', zoneId), { type });
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = toCanvasPoint(event);
    const hit = visibleZones.find((zone) => {
      const zx = zone.rect.x * canvas.width;
      const zy = zone.rect.y * canvas.height;
      const zw = zone.rect.w * canvas.width;
      const zh = zone.rect.h * canvas.height;
      return x >= zx && x <= zx + zw && y >= zy && y <= zy + zh;
    });
    if (hit) {
      setContextMenu({ x, y, zoneId: hit.id });
    } else {
      setContextMenu(null);
    }
  };

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, [contextMenu]);

  return (
    <div className="home">
      <nav className="topbar">
        <div className="logo">
          <img src={TableMateLogo} alt="TableMate logo" />
          <span>TableMate</span>
        </div>
        <div className="nav-links">
          <Link to="/home">Dashboard</Link>
          <Link to="/zones">Zones</Link>
          <Link to="/settings">Settings</Link>
          <Link to="/room">Room</Link>
        </div>
        <div className="nav-actions">
          <button className="signout" type="button" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>
      </nav>

      <header className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">Vision Intelligence</span>
          <h1>Boost reviews with a virtual employee watching every table.</h1>
          <p>
            Prioritize customer assistance so staff never miss a hand raise during rush
            hours or busy shifts. Add multiple cameras to cover blind spots and capture
            every angle of the room, so alerts stay accurate across the entire
            floor.
          </p>
          <div className="pill-row">
            <span>Table Presence</span>
            <span>Hand Gestures</span>
            <span>Live Zones</span>
          </div>
        </div>
        <div className="hero-actions">
          <button className="primary" onClick={handleEnableCamera} disabled={isRequesting}>
            {isRequesting ? 'Requesting access…' : 'Enable camera'}
          </button>
          <div className="device">
            <label htmlFor="saved-camera">Active camera</label>
            <select
              id="saved-camera"
              value={activeCamera?.id || ''}
              onChange={handleCameraSelect}
              disabled={cameras.length === 0}
            >
              {cameras.length === 0 && <option>No cameras saved</option>}
              {cameras.map((camera, index) => (
                <option key={camera.id} value={camera.id}>
                  {camera.label || `Dining Room ${index + 1}`}
                </option>
              ))}
            </select>
          </div>
          <div className="device">
            <label htmlFor="camera-select">Add camera</label>
            <select
              id="camera-select"
              value={newCameraDeviceId}
              onChange={handleDeviceChange}
              disabled={!hasDevices || !canAddCamera}
            >
              {!hasDevices && <option>No cameras found</option>}
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </div>
          <div className="camera-actions">
            <button type="button" onClick={handleAddCamera} disabled={!canAddCamera}>
              Add camera
            </button>
            <button
              type="button"
              onClick={() => {
                if (activeCamera?.id) {
                  void handleRemoveCamera(activeCamera.id);
                }
              }}
              disabled={!activeCamera}
            >
              Remove camera
            </button>
            <button type="button" onClick={refreshDevices}>
              Refresh devices
            </button>
          </div>
          <div className="status">
            <span>{status}</span>
            {activeCamera ? (
              <span>
                Using:{' '}
                {activeCamera.label ||
                  (() => {
                    const index = cameras.findIndex((camera) => camera.id === activeCamera.id);
                    return index >= 0 ? `Dining Room ${index + 1}` : 'Dining Room';
                  })()}
              </span>
            ) : null}
            {cameras.length > 0 ? (
              <span>
                Cameras saved: {cameras.length} / {maxCameras}
              </span>
            ) : null}
          </div>
          {cameras.length > 0 ? (
            <div className="camera-list">
              <span>Connected Cameras</span>
              <div className="camera-list-items">
                {cameras.map((camera, index) => {
                  const isActive = camera.id === activeCamera?.id;
                  const isAvailable = deviceAvailability.has(camera.deviceId);
                  const showConnecting = isActive && connectionStatus !== 'Good';
                  return (
                  <div key={camera.id} className="camera-list-item">
                    <div className="camera-list-info">
                      <button
                        type="button"
                        className={`camera-status ${
                          showConnecting ? 'connecting' : isAvailable ? 'active' : 'missing'
                        }`}
                        title={
                          showConnecting
                            ? 'Connecting'
                            : isAvailable
                              ? 'Connected'
                              : 'Camera not found'
                        }
                      />
                      <div>
                        {editingCameraId === camera.id ? (
                          <div className="camera-rename">
                            <input
                              value={editingCameraLabel}
                              onChange={(event) => setEditingCameraLabel(event.target.value)}
                              placeholder={`Dining Room ${index + 1}`}
                            />
                            <div className="camera-rename-actions">
                              <button type="button" onClick={() => handleRenameCamera(camera.id)}>
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCameraId(null);
                                  setEditingCameraLabel('');
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="camera-rename-display">
                            <span>{camera.label || `Dining Room ${index + 1}`}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingCameraId(camera.id);
                                setEditingCameraLabel(camera.label || `Dining Room ${index + 1}`);
                              }}
                            >
                              Rename
                            </button>
                          </div>
                        )}
                        {!isAvailable ? (
                          <span className="camera-list-warning">Camera not found</span>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveCamera(camera.id)}
                      disabled={cameras.length <= 1}
                    >
                      Remove
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {cameraStatus ? (
            <div
              className={
                cameraStatusTone === 'error'
                  ? 'error'
                  : cameraStatusTone === 'success'
                    ? 'success'
                    : 'warning'
              }
            >
              {cameraStatus}
            </div>
          ) : null}
          {deviceWarning ? (
            <div className="warning">
              <span>{deviceWarning}</span>
              <div className="warning-actions">
                <button type="button" onClick={handleUseSavedDevice}>
                  Find correct device
                </button>
                <Link to="/camera-setup">Re-setup camera</Link>
              </div>
            </div>
          ) : null}
          {error ? <div className="error">{error}</div> : null}
        </div>
      </header>

      <section className="preview">
        <div className="frame">
          {cameras.length > 1 ? (
            <div className="camera-tabs">
              {cameras.map((camera, index) => (
                <button
                  key={camera.id}
                  type="button"
                  className={camera.id === activeCamera?.id ? 'active' : ''}
                  onClick={() => {
                    setActiveCameraId(camera.id);
                    setCameraStatus('');
                  }}
                >
                  {camera.label || `Dining Room ${index + 1}`}
                </button>
              ))}
            </div>
          ) : null}
          {isActiveCameraMissing ? (
            <div className="camera-disconnected-text">Camera has been disconnected!</div>
          ) : null}
          <div className={`video-wrap ${isActiveCameraMissing ? 'disconnected' : ''}`}>
            <video ref={videoRef} autoPlay playsInline muted />
            <canvas
              ref={canvasRef}
              className={addingZone ? 'zone-canvas active' : 'zone-canvas'}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
              onContextMenu={handleContextMenu}
            />
            {contextMenu ? (
              <div className="zone-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
                <button
                  type="button"
                  onClick={() => {
                    const zone = visibleZones.find((item) => item.id === contextMenu.zoneId);
                    if (zone) handleEditZone(zone);
                    setContextMenu(null);
                  }}
                >
                  Edit zone
                </button>
                <button type="button" onClick={() => handleDeleteZone(contextMenu.zoneId)}>
                  Delete zone
                </button>
              </div>
            ) : null}
          </div>
          <div className="connection">
            Connection status: <strong>{connectionStatus}</strong>
          </div>
          {zoneError ? <div className="error">{zoneError}</div> : null}
          {assistanceZones.length ? (
            <div className="alert alert-compact">
              {assistanceZones.map((zone) => (
                <span key={zone}>
                  {profile?.messages?.assistance || 'Customer Assistance Needed'} in {zone}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <aside className="tips">
          <h2>Checklist</h2>
          <ul>
            <li>Use good lighting on tables and hands.</li>
            <li>Position the camera at table height for best accuracy.</li>
            <li>Keep the gesture in frame for a second or two.</li>
          </ul>
          <div className="zone-list">
            <div className="zone-list-header">
              <h3>Your zones</h3>
              <button
                type="button"
                className="zone-add"
                onClick={() => setShowZoneBuilder(true)}
              >
                +
              </button>
            </div>
            {showZoneBuilder ? (
              <div className="zone-builder">
                <div className="zone-description">
                  <div>
                    <strong>Table zones</strong> watch for hand‑raise gestures so staff can
                    respond quickly at each table.
                  </div>
                  <div>
                    <strong>Door zones</strong> track entries/exits and trigger your door alert
                    message when someone arrives.
                  </div>
                </div>
                {connectionStatus !== 'Good' ? (
                  <div className="error">Connect a camera before adding zones.</div>
                ) : (
                  <div className="zone-controls">
                    <button
                      type="button"
                      className="secondary"
                      onClick={handleStartZone}
                      disabled={addingZone}
                    >
                      {addingZone ? 'Click and drag to draw' : 'Draw zone on video'}
                    </button>
                    <div className="zone-type">
                      <label htmlFor="zone-type">Zone type</label>
                      <select
                        id="zone-type"
                        value={zoneType}
                        onChange={(event) => setZoneType(event.target.value as ZoneType)}
                      >
                        <option value="Table">Table</option>
                        <option value="Door">Door</option>
                      </select>
                    </div>
                    {isPlusPlan ? (
                      <div className="zone-color">
                        <label htmlFor="zone-color">Zone color</label>
                        <input
                          id="zone-color"
                          type="color"
                          value={zoneColor}
                          onChange={(event) => setZoneColor(event.target.value)}
                        />
                      </div>
                    ) : (
                      <div className="zone-color zone-color-disabled">
                        <label>Zone color</label>
                        <span>TableMate+ only</span>
                      </div>
                    )}
                    <div className="zone-name">
                      <label htmlFor="zone-name">Zone name</label>
                      <input
                        id="zone-name"
                        value={zoneName}
                        onChange={(event) => setZoneName(event.target.value)}
                        placeholder="Table 1"
                      />
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  className="zone-cancel"
                  onClick={() => {
                    setShowZoneBuilder(false);
                    setAddingZone(false);
                    setEditingZoneId(null);
                    setZoneError('');
                    setDraftZone(null);
                  }}
                >
                  Back to zone list
                </button>
              </div>
            ) : (
              <>
                {visibleZones.length === 0 ? <p>No zones yet.</p> : null}
                {visibleZones.map((zone) => {
                  const metrics = zoneMetrics[zone.id];
                  return (
                    <div className="zone-item" key={zone.id}>
                      <div className="zone-row">
                        <input
                          defaultValue={zone.name}
                          onBlur={(event) => handleZoneNameUpdate(zone.id, event.target.value)}
                        />
                        <select
                          value={zone.type}
                          onChange={(event) =>
                            handleZoneTypeUpdate(zone.id, event.target.value as ZoneType)
                          }
                        >
                          <option value="Table">Table</option>
                          <option value="Door">Door</option>
                        </select>
                      </div>
                      <div className="zone-meta">Camera: {zone.deviceName}</div>
                      <div className="zone-meta zone-color-row">
                        <span>Color</span>
                        {isPlusPlan ? (
                          <input
                            type="color"
                            value={zone.color || defaultZoneColor(zone.type)}
                            onChange={(event) =>
                              updateDoc(doc(db, 'users', auth.currentUser!.uid, 'zones', zone.id), {
                                color: event.target.value,
                              })
                            }
                          />
                        ) : (
                          <span className="zone-color-pill">Default</span>
                        )}
                      </div>
                      <div className="zone-meta">
                        Customer assistance:{' '}
                        {metrics ? `${Math.round(metrics.handConfidence * 100)}%` : '—'}
                      </div>
                      <div className="zone-actions">
                        <button type="button" onClick={() => handleEditZone(zone)}>
                          Edit
                        </button>
                        <button type="button" onClick={() => handleDeleteZone(zone.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </aside>
      </section>
      <Footer />
    </div>
  );
};

export default Home;
