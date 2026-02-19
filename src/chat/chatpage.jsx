import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import axios from "axios";
import FriendRequests from "../components/FriendRequests";
import ProfileEditModal from "../components/ProfileEditModal";
import ProfileViewModal from "../components/ProfileViewModal";
import EmojiPickerPanel from "../components/chat/EmojiPickerPanel";
import MessageItem from "../components/chat/MessageItem";
import { clearAuthSession, getAuthSession, saveAuthSession } from "../utils/authSession";
import "./chatpage.css";

const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/$/, "");
const MESSAGE_POLL_INTERVAL_MS = 2500;
const DEFAULT_WEBRTC_ICE_SERVERS = [
  {
    urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  },
  {
    urls: ["stun:openrelay.metered.ca:80"],
  },
  {
    urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turns:openrelay.metered.ca:443"],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

function normalizeIceServerConfig(rawServer) {
  if (!rawServer || typeof rawServer !== "object") {
    return null;
  }

  const urls = (Array.isArray(rawServer.urls) ? rawServer.urls : [rawServer.urls])
    .map((url) => String(url || "").trim())
    .filter(Boolean);

  if (urls.length === 0) {
    return null;
  }

  const username = String(rawServer.username || "").trim();
  const credential = String(rawServer.credential || "").trim();

  return {
    urls,
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {}),
  };
}

function parseIceServersFromEnv() {
  const rawIceServers = String(import.meta.env.VITE_WEBRTC_ICE_SERVERS || "").trim();
  if (!rawIceServers) {
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }

  try {
    const parsed = JSON.parse(rawIceServers);
    const normalized = (Array.isArray(parsed) ? parsed : [parsed]).map(normalizeIceServerConfig).filter(Boolean);
    return normalized.length > 0 ? normalized : DEFAULT_WEBRTC_ICE_SERVERS;
  } catch (error) {
    console.error("Invalid VITE_WEBRTC_ICE_SERVERS value. Falling back to default ICE servers.", error);
    return DEFAULT_WEBRTC_ICE_SERVERS;
  }
}

const WEBRTC_CONFIGURATION = {
  iceServers: parseIceServersFromEnv(),
  iceCandidatePoolSize: 10,
};

const INITIAL_CALL_STATE = {
  status: "idle",
  callType: "audio",
  peerUserId: "",
  peerName: "",
  callId: "",
  error: "",
};

const CALL_STATUS_LABELS = {
  incoming: "Incoming call",
  outgoing: "Calling...",
  connecting: "Connecting...",
  connected: "In call",
};
const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_PAYLOAD_KIND = "chat_attachment";

function normalizeCallType(callType) {
  return callType === "video" ? "video" : "audio";
}

function buildCallId(userId = "user") {
  return `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSessionDescription(description) {
  if (!description || typeof description !== "object") {
    return null;
  }

  const type = description.type === "offer" || description.type === "answer" ? description.type : "";
  const sdp = typeof description.sdp === "string" ? description.sdp : "";
  if (!type || !sdp) {
    return null;
  }

  return { type, sdp };
}

function normalizeIceCandidatePayload(candidate) {
  if (!candidate) {
    return null;
  }

  const serializedCandidate = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
  if (!serializedCandidate || typeof serializedCandidate !== "object") {
    return null;
  }

  const candidateValue = String(serializedCandidate.candidate || "").trim();
  if (!candidateValue) {
    return null;
  }

  const normalizedCandidate = { candidate: candidateValue };

  if (typeof serializedCandidate.sdpMid === "string") {
    normalizedCandidate.sdpMid = serializedCandidate.sdpMid;
  }

  if (typeof serializedCandidate.sdpMLineIndex === "number") {
    normalizedCandidate.sdpMLineIndex = serializedCandidate.sdpMLineIndex;
  }

  if (typeof serializedCandidate.usernameFragment === "string") {
    normalizedCandidate.usernameFragment = serializedCandidate.usernameFragment;
  }

  return normalizedCandidate;
}

function toId(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value._id) {
    return String(value._id);
  }

  if (typeof value?.toString === "function") {
    const serialized = value.toString();
    if (serialized && serialized !== "[object Object]") {
      return serialized;
    }
  }

  return "";
}

function buildDmChannel(userId1, userId2) {
  return `dm:${[userId1, userId2].sort().join(":")}`;
}

function buildRoomNotificationKey(roomId) {
  return `room:${roomId}`;
}

function buildDmNotificationKey(userId) {
  return `dm:${userId}`;
}

function parseAttachmentPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (
      !parsed ||
      parsed.kind !== ATTACHMENT_PAYLOAD_KIND ||
      typeof parsed.dataUrl !== "string"
    ) {
      return null;
    }

    return {
      name: String(parsed.name || "attachment"),
      mimeType: String(parsed.mimeType || ""),
      size: Number(parsed.size) || 0,
      dataUrl: parsed.dataUrl,
    };
  } catch {
    return null;
  }
}

function getNotificationPreview(rawText) {
  const attachment = parseAttachmentPayload(rawText);
  if (attachment) {
    const prefix = attachment.mimeType.startsWith("image/") ? "Image" : "File";
    return `${prefix}: ${attachment.name}`;
  }

  const text = String(rawText || "").trim();
  if (!text) {
    return "New message";
  }

  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve(String(reader.result || ""));
    };

    reader.onerror = () => {
      reject(reader.error || new Error("Failed to read file"));
    };

    reader.readAsDataURL(file);
  });
}

function getUserDisplayName(user) {
  if (!user) {
    return "Unknown";
  }

  return user.displayName || user.username || user.name || user.email || "Unknown";
}

function getUserAvatarUrl(user) {
  if (!user || typeof user !== "object") {
    return "";
  }

  const avatarCandidates = [
    user.avatarUrl,
    user.avatar,
    user.profilePicture,
    user.photoUrl,
    user.photoURL,
    user.image,
  ];

  for (const candidate of avatarCandidates) {
    let value = "";

    if (typeof candidate === "string") {
      value = candidate.trim();
    } else if (candidate && typeof candidate === "object") {
      value = String(candidate.url || candidate.secure_url || candidate.src || "").trim();
    }

    if (!value) {
      continue;
    }

    if (
      value.startsWith("data:") ||
      value.startsWith("blob:") ||
      /^https?:\/\//i.test(value)
    ) {
      return value;
    }

    if (value.startsWith("//")) {
      const protocol = typeof window !== "undefined" ? window.location.protocol : "https:";
      return `${protocol}${value}`;
    }

    if (value.startsWith("/")) {
      return `${API_BASE_URL}${value}`;
    }

    return `${API_BASE_URL}/${value.replace(/^\/+/, "")}`;
  }

  return "";
}

function normalizeUserForUi(user) {
  return {
    ...user,
    displayName: getUserDisplayName(user),
    avatarUrl: getUserAvatarUrl(user),
  };
}

function normalizeIdentityText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeReaction(reaction) {
  return {
    user: toId(reaction?.user),
    emoji: reaction?.emoji || "",
  };
}

function normalizeReplyPreview(replyToMessage) {
  if (!replyToMessage || typeof replyToMessage !== "object") {
    return null;
  }

  return {
    _id: toId(replyToMessage),
    senderUserId: replyToMessage.senderUserId || null,
    messageContent: String(replyToMessage.messageContent || ""),
    createdAt: replyToMessage.createdAt || "",
  };
}

function isRoomMember(room, userId) {
  if (!room || !Array.isArray(room.members) || !userId) {
    return false;
  }

  return room.members.some((member) => String(toId(member)) === String(userId));
}

function areReactionsEqual(previous = [], next = []) {
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    const left = normalizeReaction(previous[index]);
    const right = normalizeReaction(next[index]);
    if (left.user !== right.user || left.emoji !== right.emoji) {
      return false;
    }
  }

  return true;
}

function shouldReuseMessage(previousMessage, nextMessage) {
  if (!previousMessage) {
    return false;
  }

  const previousReply = normalizeReplyPreview(previousMessage.replyTo);
  const nextReply = normalizeReplyPreview(nextMessage.replyTo);
  const isReplyEqual =
    (!previousReply && !nextReply) ||
    (Boolean(previousReply) &&
      Boolean(nextReply) &&
      previousReply._id === nextReply._id &&
      previousReply.messageContent === nextReply.messageContent &&
      toId(previousReply.senderUserId) === toId(nextReply.senderUserId) &&
      String(previousReply.createdAt) === String(nextReply.createdAt));

  return (
    String(previousMessage._id) === String(nextMessage._id) &&
    previousMessage.messageContent === nextMessage.messageContent &&
    previousMessage.messageType === nextMessage.messageType &&
    previousMessage.readStatus === nextMessage.readStatus &&
    String(previousMessage.createdAt) === String(nextMessage.createdAt) &&
    String(previousMessage.updatedAt) === String(nextMessage.updatedAt) &&
    toId(previousMessage.senderUserId) === toId(nextMessage.senderUserId) &&
    areReactionsEqual(previousMessage.reactions || [], nextMessage.reactions || []) &&
    isReplyEqual
  );
}

function reconcileMessages(previousMessages, incomingMessages) {
  const previousById = new Map(previousMessages.map((message) => [String(message._id), message]));

  return incomingMessages.map((message) => {
    const normalizedMessage = {
      ...message,
      reactions: Array.isArray(message.reactions) ? message.reactions : [],
      replyTo: normalizeReplyPreview(message.replyTo),
    };

    const existing = previousById.get(String(normalizedMessage._id));
    if (shouldReuseMessage(existing, normalizedMessage)) {
      return existing;
    }

    return normalizedMessage;
  });
}

function ThemeIcon({ theme }) {
  if (theme === "light") {
    return (
      <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.5v2.3M12 19.2v2.3M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.5 12h2.3M19.2 12h2.3M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M10 3H7.8A2.8 2.8 0 0 0 5 5.8v12.4A2.8 2.8 0 0 0 7.8 21H10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M14.5 8.5 19 12l-4.5 3.5M19 12H10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EmojiIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="9" cy="10" r="1.05" fill="currentColor" />
      <circle cx="15" cy="10" r="1.05" fill="currentColor" />
      <path
        d="M8.6 14.2c.9 1.3 2.1 1.9 3.4 1.9s2.5-.6 3.4-1.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AttachmentIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M15.5 6.5 8.6 13.4a3.1 3.1 0 1 0 4.4 4.4l7-7a5 5 0 0 0-7.1-7.1l-7.2 7.2a7 7 0 0 0 9.9 9.9l5.8-5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6.4 3.4c.7-.7 1.8-.7 2.5 0l1.9 1.9c.7.7.7 1.8 0 2.5l-1.1 1.1a14.3 14.3 0 0 0 5.4 5.4l1.1-1.1c.7-.7 1.8-.7 2.5 0l1.9 1.9c.7.7.7 1.8 0 2.5l-1.2 1.2c-.9.9-2.2 1.3-3.5 1-2.5-.6-5.2-2.1-7.7-4.6s-4-5.2-4.6-7.7c-.3-1.3.1-2.6 1-3.5l1.2-1.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg className="header-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="6" width="13" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M16 10.2 21 7.5v9l-5-2.7v-3.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg className="no-chat-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6.5 18.5 3 21V5.8A2.8 2.8 0 0 1 5.8 3h12.4A2.8 2.8 0 0 1 21 5.8v9.4A2.8 2.8 0 0 1 18.2 18H6.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatPage({ theme: propsTheme, setTheme: propsSetTheme }) {
  const [rooms, setRooms] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [replyToMessage, setReplyToMessage] = useState(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [activeTab, setActiveTab] = useState("chats");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isSendingAttachment, setIsSendingAttachment] = useState(false);
  const [userFollowStatus, setUserFollowStatus] = useState({});
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [roomError, setRoomError] = useState("");
  const [roomMemberError, setRoomMemberError] = useState("");
  const [roomMemberAction, setRoomMemberAction] = useState({ type: "", userId: "" });
  const [isClearingConversation, setIsClearingConversation] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const [showProfileView, setShowProfileView] = useState(false);
  const [viewedUser, setViewedUser] = useState(null);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [callState, setCallState] = useState(INITIAL_CALL_STATE);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const [currentUserId, setCurrentUserId] = useState(() => getAuthSession().userId);
  const [userName, setUserName] = useState(() => getAuthSession().username);
  const [token, setToken] = useState(() => getAuthSession().token);
  const [currentUserProfile, setCurrentUserProfile] = useState(() => {
    const session = getAuthSession();
    return normalizeUserForUi({
      _id: session.userId || "",
      username: session.username || "",
      bio: "",
      phoneNumber: "",
      email: "",
      avatarUrl: "",
    });
  });

  const messagesEndRef = useRef(null);
  const messageInputRef = useRef(null);
  const emojiTriggerWrapRef = useRef(null);
  const emojiToggleButtonRef = useRef(null);
  const fileInputRef = useRef(null);
  const socketRef = useRef(null);
  const joinedConversationRef = useRef(null);
  const wasEmojiOpenRef = useRef(false);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const pendingIncomingCallRef = useRef(null);
  const queuedIceCandidatesRef = useRef([]);
  const activeCallPeerIdRef = useRef("");
  const activeCallIdRef = useRef("");
  const activeCallTypeRef = useRef("audio");
  const usersRef = useRef([]);
  const activeNotificationKeyRef = useRef("");
  const processedRealtimeMessageIdsRef = useRef(new Set());
  const notificationPermissionRequestedRef = useRef(false);
  const notificationAudioContextRef = useRef(null);

  const [localTheme, setLocalTheme] = useState(() => localStorage.getItem("theme") || "light");
  const theme = propsTheme !== undefined ? propsTheme : localTheme;

  useEffect(() => {
    if (propsTheme === undefined) {
      document.documentElement.setAttribute("data-theme", localTheme);
      localStorage.setItem("theme", localTheme);
    }
  }, [localTheme, propsTheme]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    const syncAuthSession = () => {
      const session = getAuthSession();
      setCurrentUserId(session.userId);
      setUserName(session.username);
      setToken(session.token);
      setCurrentUserProfile((previous) =>
        normalizeUserForUi({
          ...(previous || {}),
          _id: session.userId || previous?._id || "",
          username: session.username || previous?.username || "",
        }),
      );
    };

    window.addEventListener("storage", syncAuthSession);
    return () => {
      window.removeEventListener("storage", syncAuthSession);
    };
  }, []);

  const resolvePeerName = useCallback((peerUserId, fallbackName = "") => {
    if (fallbackName) {
      return fallbackName;
    }

    const matchedUser = usersRef.current.find((user) => String(user._id) === String(peerUserId));
    if (matchedUser) {
      return getUserDisplayName(matchedUser);
    }

    if (peerUserId) {
      const suffix = String(peerUserId).slice(-4);
      return `User ${suffix}`;
    }

    return "Unknown";
  }, []);

  const activeNotificationKey = useMemo(() => {
    if (selectedRoom?._id) {
      return buildRoomNotificationKey(String(selectedRoom._id));
    }

    if (selectedUser?._id) {
      return buildDmNotificationKey(String(selectedUser._id));
    }

    return "";
  }, [selectedRoom?._id, selectedUser?._id]);

  const clearUnreadForKey = useCallback((notificationKey) => {
    if (!notificationKey) {
      return;
    }

    setUnreadCounts((previous) => {
      if (!previous[notificationKey]) {
        return previous;
      }

      const next = { ...previous };
      delete next[notificationKey];
      return next;
    });
  }, []);

  useEffect(() => {
    activeNotificationKeyRef.current = activeNotificationKey;
    clearUnreadForKey(activeNotificationKey);
  }, [activeNotificationKey, clearUnreadForKey]);

  const getMessageNotificationKey = useCallback(
    (message) => {
      const senderId = toId(message?.senderUserId);
      const targetId = toId(message?.receiverUserIdOrRoomId);
      const selfUserId = String(currentUserId || "");

      if (!senderId || !targetId || !selfUserId || senderId === selfUserId) {
        return "";
      }

      if (targetId === selfUserId) {
        return buildDmNotificationKey(senderId);
      }

      return buildRoomNotificationKey(targetId);
    },
    [currentUserId],
  );

  const playNotificationSound = useCallback(() => {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        return;
      }

      if (!notificationAudioContextRef.current) {
        notificationAudioContextRef.current = new AudioContextClass();
      }

      const audioContext = notificationAudioContextRef.current;
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      const startAt = audioContext.currentTime;

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(920, startAt);
      gainNode.gain.setValueAtTime(0.0001, startAt);
      gainNode.gain.exponentialRampToValueAtTime(0.08, startAt + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.18);

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.2);
    } catch {
      // no-op
    }
  }, []);

  const showBrowserNotification = useCallback((title, body) => {
    if (!("Notification" in window)) {
      return;
    }

    const isPageFocused = document.visibilityState === "visible" && document.hasFocus();
    if (isPageFocused) {
      return;
    }

    if (Notification.permission === "granted") {
      new Notification(title, { body, tag: "chat-new-message" });
      return;
    }

    if (Notification.permission === "default" && !notificationPermissionRequestedRef.current) {
      notificationPermissionRequestedRef.current = true;
      Notification.requestPermission()
        .then((permission) => {
          if (permission === "granted") {
            new Notification(title, { body, tag: "chat-new-message" });
          }
        })
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    return () => {
      if (notificationAudioContextRef.current) {
        notificationAudioContextRef.current.close().catch(() => {});
        notificationAudioContextRef.current = null;
      }
    };
  }, []);

  const appendRealtimeMessage = useCallback((message) => {
    if (!message?._id) {
      return;
    }

    setMessages((previous) => {
      if (previous.some((existing) => String(existing._id) === String(message._id))) {
        return previous;
      }

      const normalizedMessage = {
        ...message,
        reactions: Array.isArray(message.reactions) ? message.reactions : [],
        replyTo: normalizeReplyPreview(message.replyTo),
      };

      return [...previous, normalizedMessage];
    });
  }, []);

  const resetCallSession = useCallback((errorMessage = "", options = {}) => {
    const { skipStateUpdate = false } = options;

    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.ontrack = null;
        peerConnectionRef.current.onicecandidate = null;
        peerConnectionRef.current.onconnectionstatechange = null;
        peerConnectionRef.current.close();
      } catch {
        // no-op
      }
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((track) => track.stop());
      remoteStreamRef.current = null;
    }

    pendingIncomingCallRef.current = null;
    queuedIceCandidatesRef.current = [];
    activeCallPeerIdRef.current = "";
    activeCallIdRef.current = "";
    activeCallTypeRef.current = "audio";

    if (skipStateUpdate) {
      return;
    }

    setLocalStream(null);
    setRemoteStream(null);
    setIsMicMuted(false);
    setIsCameraOff(false);
    setCallState({ ...INITIAL_CALL_STATE, error: errorMessage });
  }, []);

  const flushQueuedIceCandidates = useCallback(async () => {
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection || !peerConnection.remoteDescription) {
      return;
    }

    const queuedCandidates = [...queuedIceCandidatesRef.current];
    queuedIceCandidatesRef.current = [];

    for (const candidate of queuedCandidates) {
      try {
        await peerConnection.addIceCandidate(candidate);
      } catch (error) {
        console.error("Failed to add queued ICE candidate:", error);
      }
    }
  }, []);

  const endActiveCall = useCallback(
    ({ notifyPeer = true, reason = "ended", errorMessage = "", skipStateUpdate = false } = {}) => {
      const socket = socketRef.current;
      if (notifyPeer && socket && activeCallPeerIdRef.current) {
        socket.emit("call:end", {
          toUserId: activeCallPeerIdRef.current,
          callId: activeCallIdRef.current || null,
          reason,
        });
      }

      resetCallSession(errorMessage, { skipStateUpdate });
    },
    [resetCallSession],
  );

  const createPeerConnection = useCallback(
    (targetUserId, callId, callType) => {
      const socket = socketRef.current;
      if (!socket) {
        throw new Error("Socket is not connected");
      }

      if (peerConnectionRef.current) {
        try {
          peerConnectionRef.current.close();
        } catch {
          // no-op
        }
      }

      const peerConnection = new RTCPeerConnection(WEBRTC_CONFIGURATION);

      peerConnection.onicecandidate = (event) => {
        const normalizedCandidate = normalizeIceCandidatePayload(event.candidate);
        if (!normalizedCandidate || !targetUserId) {
          return;
        }

        socket.emit("call:ice-candidate", {
          toUserId: targetUserId,
          callId,
          candidate: normalizedCandidate,
        });
      };

      peerConnection.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) {
          return;
        }

        remoteStreamRef.current = stream;
        setRemoteStream(stream);
        setCallState((previous) => ({ ...previous, status: "connected" }));
      };

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;

        if (state === "connected") {
          setCallState((previous) => ({ ...previous, status: "connected" }));
          return;
        }

        if (state === "failed") {
          endActiveCall({
            notifyPeer: false,
            reason: "failed",
            errorMessage: "Call connection failed. Check your network or TURN server settings.",
          });
          return;
        }

        if (state === "disconnected") {
          setCallState((previous) =>
            previous.status === "connected" ? { ...previous, status: "connecting" } : previous,
          );
          return;
        }

        if (state === "closed") {
          endActiveCall({ notifyPeer: false, reason: state });
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        const iceState = peerConnection.iceConnectionState;

        if (iceState === "connected" || iceState === "completed") {
          setCallState((previous) => ({ ...previous, status: "connected" }));
          return;
        }

        if (iceState === "failed") {
          endActiveCall({
            notifyPeer: false,
            reason: "failed",
            errorMessage: "Call connection failed. Check your network or TURN server settings.",
          });
        }
      };

      peerConnection.onicecandidateerror = (event) => {
        console.error("ICE candidate error:", {
          address: event.address,
          port: event.port,
          url: event.url,
          errorCode: event.errorCode,
          errorText: event.errorText,
        });
      };

      peerConnectionRef.current = peerConnection;
      activeCallPeerIdRef.current = String(targetUserId || "");
      activeCallIdRef.current = callId || "";
      activeCallTypeRef.current = normalizeCallType(callType);

      return peerConnection;
    },
    [endActiveCall],
  );

  const requestLocalMedia = useCallback(async (callType) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Your browser does not support calling features.");
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: normalizeCallType(callType) === "video",
    });

    localStreamRef.current = stream;
    setLocalStream(stream);
    return stream;
  }, []);

  const handleStartCall = useCallback(
    async (nextCallType) => {
      if (!selectedUser?._id || !currentUserId) {
        return;
      }

      if (callState.status !== "idle") {
        return;
      }

      const callType = normalizeCallType(nextCallType);
      const peerUserId = String(selectedUser._id);
      const peerName = getUserDisplayName(selectedUser);
      const callId = buildCallId(currentUserId);

      try {
        queuedIceCandidatesRef.current = [];
        const stream = await requestLocalMedia(callType);
        const peerConnection = createPeerConnection(peerUserId, callId, callType);

        stream.getTracks().forEach((track) => {
          peerConnection.addTrack(track, stream);
        });

        setCallState({
          status: "outgoing",
          callType,
          peerUserId,
          peerName,
          callId,
          error: "",
        });

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        const normalizedOffer = normalizeSessionDescription(peerConnection.localDescription || offer);
        if (!normalizedOffer) {
          throw new Error("Unable to create call offer.");
        }

        socketRef.current?.emit("call:offer", {
          toUserId: peerUserId,
          callType,
          callId,
          offer: normalizedOffer,
          fromUserName: userName || "",
        });

        setCallState((previous) =>
          previous.status === "outgoing" ? { ...previous, status: "connecting" } : previous,
        );
      } catch (error) {
        console.error("Failed to start call:", error);
        endActiveCall({
          notifyPeer: false,
          errorMessage:
            error?.message || "Unable to start call. Check microphone/camera permissions and try again.",
        });
      }
    },
    [callState.status, createPeerConnection, currentUserId, endActiveCall, requestLocalMedia, selectedUser, userName],
  );

  const handleAcceptIncomingCall = useCallback(async () => {
    const pendingCall = pendingIncomingCallRef.current;
    if (!pendingCall) {
      return;
    }

    const { fromUserId, offer, callType, callId, peerName } = pendingCall;

    try {
      const stream = await requestLocalMedia(callType);
      const peerConnection = createPeerConnection(fromUserId, callId, callType);

      stream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
      });

      setCallState({
        status: "connecting",
        callType,
        peerUserId: fromUserId,
        peerName,
        callId,
        error: "",
      });

      const normalizedOffer = normalizeSessionDescription(offer);
      if (!normalizedOffer) {
        throw new Error("Invalid call offer.");
      }

      await peerConnection.setRemoteDescription(normalizedOffer);
      await flushQueuedIceCandidates();

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      const normalizedAnswer = normalizeSessionDescription(peerConnection.localDescription || answer);
      if (!normalizedAnswer) {
        throw new Error("Unable to create call answer.");
      }

      socketRef.current?.emit("call:answer", {
        toUserId: fromUserId,
        callId,
        answer: normalizedAnswer,
      });

      pendingIncomingCallRef.current = null;
    } catch (error) {
      console.error("Failed to accept call:", error);
      socketRef.current?.emit("call:end", {
        toUserId: fromUserId,
        callId,
        reason: "error",
      });
      endActiveCall({ notifyPeer: false, errorMessage: "Unable to accept call." });
    }
  }, [createPeerConnection, endActiveCall, flushQueuedIceCandidates, requestLocalMedia]);

  const handleDeclineIncomingCall = useCallback(() => {
    const pendingCall = pendingIncomingCallRef.current;
    if (!pendingCall) {
      return;
    }

    socketRef.current?.emit("call:end", {
      toUserId: pendingCall.fromUserId,
      callId: pendingCall.callId || null,
      reason: "declined",
    });

    endActiveCall({ notifyPeer: false });
  }, [endActiveCall]);

  const handleToggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      return;
    }

    const shouldMute = audioTracks.some((track) => track.enabled);
    audioTracks.forEach((track) => {
      track.enabled = !shouldMute;
    });
    setIsMicMuted(shouldMute);
  }, []);

  const handleToggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) {
      return;
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      return;
    }

    const shouldDisable = videoTracks.some((track) => track.enabled);
    videoTracks.forEach((track) => {
      track.enabled = !shouldDisable;
    });
    setIsCameraOff(shouldDisable);
  }, []);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream || null;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream || null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream || null;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (!callState.error) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCallState((previous) => (previous.error ? { ...previous, error: "" } : previous));
    }, 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [callState.error]);

  useEffect(() => {
    if (!token || !currentUserId) {
      window.location.href = "/";
    }
  }, [token, currentUserId]);

  useEffect(() => {
    if (!token) {
      delete axios.defaults.headers.common.Authorization;
      delete axios.defaults.headers.common["x-auth-token"];
      return;
    }

    axios.defaults.headers.common.Authorization = `Bearer ${token}`;
    axios.defaults.headers.common["x-auth-token"] = token;
  }, [token]);

  useEffect(() => {
    if (!currentUserId) {
      return;
    }

    const socket = io(API_BASE_URL, {
      auth: { userId: currentUserId },
      query: { userId: currentUserId },
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;
    const processedRealtimeMessageIds = processedRealtimeMessageIdsRef.current;

    const onReactionUpdated = (payload) => {
      if (!payload?.messageId || !Array.isArray(payload.reactions)) {
        return;
      }

      setMessages((previous) => {
        let changed = false;
        const next = previous.map((message) => {
          if (String(message._id) !== String(payload.messageId)) {
            return message;
          }

          changed = true;
          return { ...message, reactions: payload.reactions };
        });

        return changed ? next : previous;
      });
    };

    const onMessageDeleted = (payload = {}) => {
      const deletedMessageId = payload?.messageId ? String(payload.messageId) : "";
      if (!deletedMessageId) {
        return;
      }

      setMessages((previous) => {
        let changed = false;
        const next = previous
          .filter((message) => {
            const shouldKeep = String(message._id) !== deletedMessageId;
            if (!shouldKeep) {
              changed = true;
            }
            return shouldKeep;
          })
          .map((message) => {
            const replyId = toId(message.replyTo);
            if (replyId && String(replyId) === deletedMessageId) {
              changed = true;
              return { ...message, replyTo: null };
            }

            return message;
          });

        return changed ? next : previous;
      });

      setReplyToMessage((previous) =>
        previous && String(previous._id) === deletedMessageId ? null : previous,
      );
    };

    const onConversationCleared = (payload = {}) => {
      const conversationTargetId = payload?.receiverUserIdOrRoomId
        ? String(payload.receiverUserIdOrRoomId)
        : "";
      if (!conversationTargetId) {
        return;
      }

      const dmNotificationKey = buildDmNotificationKey(conversationTargetId);
      const roomNotificationKey = buildRoomNotificationKey(conversationTargetId);

      clearUnreadForKey(dmNotificationKey);
      clearUnreadForKey(roomNotificationKey);

      const isActiveConversation =
        activeNotificationKeyRef.current === dmNotificationKey ||
        activeNotificationKeyRef.current === roomNotificationKey;

      if (isActiveConversation) {
        setMessages([]);
        setReplyToMessage(null);
      }
    };

    const onNewMessage = (payload = {}) => {
      const incomingMessage = payload?.data || payload?.message || payload;
      const messageId = incomingMessage?._id ? String(incomingMessage._id) : "";

      if (!messageId) {
        return;
      }

      if (processedRealtimeMessageIds.has(messageId)) {
        return;
      }

      processedRealtimeMessageIds.add(messageId);
      if (processedRealtimeMessageIds.size > 500) {
        const oldestId = processedRealtimeMessageIds.values().next().value;
        processedRealtimeMessageIds.delete(oldestId);
      }

      const notificationKey = getMessageNotificationKey(incomingMessage);
      if (!notificationKey) {
        return;
      }

      const senderName = getUserDisplayName(incomingMessage.senderUserId);
      const previewText = getNotificationPreview(incomingMessage.messageContent);
      const isActiveConversation = notificationKey === activeNotificationKeyRef.current;
      const isPageFocused = document.visibilityState === "visible" && document.hasFocus();

      if (isActiveConversation) {
        appendRealtimeMessage(incomingMessage);

        if (!isPageFocused) {
          playNotificationSound();
          showBrowserNotification(senderName, previewText);
        }
        return;
      }

      setUnreadCounts((previous) => ({
        ...previous,
        [notificationKey]: (previous[notificationKey] || 0) + 1,
      }));

      playNotificationSound();
      showBrowserNotification(senderName, previewText);
    };

    const removeRoomFromUi = (roomId) => {
      if (!roomId) {
        return;
      }

      const normalizedRoomId = String(roomId);
      const roomNotificationKey = buildRoomNotificationKey(normalizedRoomId);

      setRooms((previous) =>
        previous.filter((room) => String(room._id) !== normalizedRoomId),
      );
      setSelectedRoom((previous) =>
        previous && String(previous._id) === normalizedRoomId ? null : previous,
      );
      setUnreadCounts((previous) => {
        if (!previous[roomNotificationKey]) {
          return previous;
        }

        const next = { ...previous };
        delete next[roomNotificationKey];
        return next;
      });
    };

    const onRoomMembershipChanged = (payload = {}) => {
      const updatedRoom = payload?.room;
      if (!updatedRoom?._id) {
        return;
      }

      if (!isRoomMember(updatedRoom, currentUserId)) {
        removeRoomFromUi(updatedRoom._id);
        return;
      }

      setRooms((previous) => {
        const exists = previous.some((room) => String(room._id) === String(updatedRoom._id));
        if (!exists) {
          return [updatedRoom, ...previous];
        }

        return previous.map((room) =>
          String(room._id) === String(updatedRoom._id) ? updatedRoom : room,
        );
      });

      setSelectedRoom((previous) =>
        previous && String(previous._id) === String(updatedRoom._id) ? updatedRoom : previous,
      );
    };

    const onRoomRemoved = (payload = {}) => {
      const roomId = payload?.roomId || payload?.room?._id;
      removeRoomFromUi(roomId);
    };

    const onCallOffer = (payload = {}) => {
      const fromUserId = payload?.fromUserId ? String(payload.fromUserId) : "";
      const normalizedOffer = normalizeSessionDescription(payload?.offer);
      if (!fromUserId || !normalizedOffer) {
        return;
      }

      const incomingCallType = normalizeCallType(payload?.callType);
      const incomingCallId = payload?.callId || buildCallId(fromUserId);
      const peerName = resolvePeerName(fromUserId, payload?.fromUserName || "");
      const hasActiveCall = Boolean(
        pendingIncomingCallRef.current || activeCallPeerIdRef.current || peerConnectionRef.current,
      );

      if (hasActiveCall) {
        socket.emit("call:end", {
          toUserId: fromUserId,
          callId: incomingCallId,
          reason: "busy",
        });
        return;
      }

      queuedIceCandidatesRef.current = [];
      pendingIncomingCallRef.current = {
        fromUserId,
        callType: incomingCallType,
        callId: incomingCallId,
        offer: normalizedOffer,
        peerName,
      };

      activeCallPeerIdRef.current = fromUserId;
      activeCallIdRef.current = incomingCallId;
      activeCallTypeRef.current = incomingCallType;

      setCallState({
        status: "incoming",
        callType: incomingCallType,
        peerUserId: fromUserId,
        peerName,
        callId: incomingCallId,
        error: "",
      });
    };

    const onCallAnswer = async (payload = {}) => {
      if (payload?.callId && activeCallIdRef.current && String(payload.callId) !== String(activeCallIdRef.current)) {
        return;
      }

      const peerConnection = peerConnectionRef.current;
      const normalizedAnswer = normalizeSessionDescription(payload?.answer);
      if (!peerConnection || !normalizedAnswer) {
        return;
      }

      try {
        await peerConnection.setRemoteDescription(normalizedAnswer);
        await flushQueuedIceCandidates();
        setCallState((previous) =>
          previous.status === "incoming" ? previous : { ...previous, status: "connecting" },
        );
      } catch (error) {
        console.error("Failed to apply call answer:", error);
        endActiveCall({ notifyPeer: false, errorMessage: "Failed to connect call." });
      }
    };

    const onCallIceCandidate = async (payload = {}) => {
      const normalizedCandidate = normalizeIceCandidatePayload(payload?.candidate);
      if (!normalizedCandidate) {
        return;
      }

      if (payload?.callId && activeCallIdRef.current && String(payload.callId) !== String(activeCallIdRef.current)) {
        return;
      }

      try {
        const candidate = new RTCIceCandidate(normalizedCandidate);
        const peerConnection = peerConnectionRef.current;

        if (!peerConnection || !peerConnection.remoteDescription) {
          queuedIceCandidatesRef.current.push(candidate);
          return;
        }

        await peerConnection.addIceCandidate(candidate);
      } catch (error) {
        console.error("Failed to apply ICE candidate:", error);
      }
    };

    const onCallEnd = (payload = {}) => {
      if (payload?.callId && activeCallIdRef.current && String(payload.callId) !== String(activeCallIdRef.current)) {
        return;
      }

      const reason = payload?.reason || "ended";
      if (reason === "busy") {
        endActiveCall({ notifyPeer: false, errorMessage: "User is busy on another call." });
        return;
      }

      if (reason === "declined") {
        endActiveCall({ notifyPeer: false, errorMessage: "Call declined." });
        return;
      }

      endActiveCall({ notifyPeer: false });
    };

    socket.on("message:reaction_updated", onReactionUpdated);
    socket.on("message:new", onNewMessage);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("conversation:cleared", onConversationCleared);
    socket.on("room:membership_changed", onRoomMembershipChanged);
    socket.on("room:removed", onRoomRemoved);
    socket.on("call:offer", onCallOffer);
    socket.on("call:answer", onCallAnswer);
    socket.on("call:ice-candidate", onCallIceCandidate);
    socket.on("call:end", onCallEnd);

    return () => {
      socket.off("message:reaction_updated", onReactionUpdated);
      socket.off("message:new", onNewMessage);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("conversation:cleared", onConversationCleared);
      socket.off("room:membership_changed", onRoomMembershipChanged);
      socket.off("room:removed", onRoomRemoved);
      socket.off("call:offer", onCallOffer);
      socket.off("call:answer", onCallAnswer);
      socket.off("call:ice-candidate", onCallIceCandidate);
      socket.off("call:end", onCallEnd);
      endActiveCall({ notifyPeer: false, skipStateUpdate: true });
      socket.disconnect();
      socketRef.current = null;
      joinedConversationRef.current = null;
      processedRealtimeMessageIds.clear();
    };
  }, [
    appendRealtimeMessage,
    clearUnreadForKey,
    currentUserId,
    endActiveCall,
    flushQueuedIceCandidates,
    getMessageNotificationKey,
    playNotificationSound,
    resolvePeerName,
    showBrowserNotification,
  ]);

  const conversationChannel = useMemo(() => {
    if (!currentUserId) {
      return null;
    }

    if (selectedRoom?._id) {
      return `room:${selectedRoom._id}`;
    }

    if (selectedUser?._id) {
      return buildDmChannel(currentUserId, selectedUser._id);
    }

    return null;
  }, [currentUserId, selectedRoom, selectedUser]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }

    const previousConversation = joinedConversationRef.current;

    if (previousConversation && previousConversation !== conversationChannel) {
      socket.emit("conversation:leave", { conversationId: previousConversation });
    }

    if (conversationChannel && previousConversation !== conversationChannel) {
      socket.emit("conversation:join", { conversationId: conversationChannel });
      joinedConversationRef.current = conversationChannel;
      return;
    }

    if (!conversationChannel) {
      joinedConversationRef.current = null;
    }
  }, [conversationChannel]);

  const fetchMessages = useCallback(async () => {
    if (selectedRoom?._id) {
      const response = await axios.get(`${API_BASE_URL}/api/messages/${selectedRoom._id}`);
      setMessages((previous) => reconcileMessages(previous, response.data || []));
      return;
    }

    if (selectedUser?._id && currentUserId) {
      const response = await axios.get(
        `${API_BASE_URL}/api/messages/between/${currentUserId}/${selectedUser._id}`,
      );
      setMessages((previous) => reconcileMessages(previous, response.data || []));
    }
  }, [currentUserId, selectedRoom, selectedUser]);

  useEffect(() => {
    if (!selectedRoom && !selectedUser) {
      setMessages([]);
      return;
    }

    fetchMessages().catch((error) => {
      console.error("Failed to fetch messages:", error);
    });

    const intervalId = window.setInterval(() => {
      fetchMessages().catch((error) => {
        console.error("Message polling failed:", error);
      });
    }, MESSAGE_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchMessages, selectedRoom, selectedUser]);

  useEffect(() => {
    setReplyToMessage(null);
  }, [selectedRoom?._id, selectedUser?._id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length]);

  useEffect(() => {
    const textArea = messageInputRef.current;
    if (!textArea) {
      return;
    }

    textArea.style.height = "auto";
    textArea.style.height = `${Math.min(textArea.scrollHeight, 160)}px`;
  }, [newMessage]);

  useEffect(() => {
    if (!currentUserId) {
      return;
    }

    const fetchInitialData = async () => {
      try {
        setIsLoading(true);
        const [roomsResponse, usersResponse] = await Promise.all([
          axios.get(`${API_BASE_URL}/api/chatrooms`, {
            params: { memberId: currentUserId },
          }),
          axios.get(`${API_BASE_URL}/api/users`),
        ]);

        const nextRooms = Array.isArray(roomsResponse.data) ? roomsResponse.data : [];
        setRooms(nextRooms.filter((room) => isRoomMember(room, currentUserId)));

        const normalizedUsers = (usersResponse.data || []).map(normalizeUserForUi);
        const selfUser = normalizedUsers.find((user) => String(user._id) === String(currentUserId));
        if (selfUser) {
          setCurrentUserProfile(selfUser);
          if (selfUser.username) {
            setUserName(selfUser.username);
          }
        }

        const otherUsers = normalizedUsers.filter((user) => String(user._id) !== String(currentUserId));

        setUsers(otherUsers);
      } catch (error) {
        console.error("Failed to fetch rooms/users:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchInitialData();
  }, [currentUserId]);

  const fetchFollowStatus = useCallback(async () => {
    if (!currentUserId) {
      return;
    }

    try {
      const [followingResponse, sentResponse] = await Promise.all([
        axios.get(`${API_BASE_URL}/api/users/${currentUserId}/following`),
        axios.get(`${API_BASE_URL}/api/users/${currentUserId}/sent-follow-requests`),
      ]);

      const statusMap = {};

      (followingResponse.data.following || []).forEach((user) => {
        statusMap[user._id] = "following";
      });

      (sentResponse.data.sentRequests || []).forEach((user) => {
        statusMap[user._id] = "pending";
      });

      setUserFollowStatus(statusMap);
    } catch (error) {
      console.error("Failed to fetch follow status:", error);
    }
  }, [currentUserId]);

  useEffect(() => {
    fetchFollowStatus();
  }, [fetchFollowStatus]);

  useEffect(() => {
    if (!currentUserId) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      fetchFollowStatus();
    }, 10000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [currentUserId, fetchFollowStatus]);

  const removeRoomById = useCallback((roomId) => {
    if (!roomId) {
      return;
    }

    setRooms((previous) => previous.filter((room) => String(room._id) !== String(roomId)));
    setSelectedRoom((previous) =>
      previous && String(previous._id) === String(roomId) ? null : previous,
    );
  }, []);

  const applyUpdatedRoom = useCallback((updatedRoom) => {
    if (!updatedRoom?._id) {
      return;
    }

    if (!isRoomMember(updatedRoom, currentUserId)) {
      removeRoomById(updatedRoom._id);
      return;
    }

    setRooms((previous) => {
      const roomExists = previous.some((room) => String(room._id) === String(updatedRoom._id));
      if (!roomExists) {
        return [updatedRoom, ...previous];
      }

      return previous.map((room) =>
        String(room._id) === String(updatedRoom._id) ? updatedRoom : room,
      );
    });

    setSelectedRoom((previous) =>
      previous && String(previous._id) === String(updatedRoom._id) ? updatedRoom : previous,
    );
  }, [currentUserId, removeRoomById]);

  useEffect(() => {
    if (!selectedRoom?._id) {
      return;
    }

    const roomStillExists = rooms.some((room) => String(room._id) === String(selectedRoom._id));
    if (roomStillExists) {
      return;
    }

    setSelectedRoom(null);
    setShowRoomInfo(false);
    setRoomMemberError("");
    setRoomMemberAction({ type: "", userId: "" });
  }, [rooms, selectedRoom?._id]);

  useEffect(() => {
    if (!showRoomInfo || !selectedRoom?._id) {
      return;
    }

    axios
      .get(`${API_BASE_URL}/api/chatrooms/${selectedRoom._id}`)
      .then((response) => {
        if (response.data?._id) {
          applyUpdatedRoom(response.data);
        }
      })
      .catch((error) => {
        console.error("Failed to refresh room details:", error);
      });
  }, [applyUpdatedRoom, selectedRoom?._id, showRoomInfo]);

  const closeEmojiPicker = useCallback(() => {
    setShowEmojiPicker(false);
  }, []);

  const toggleEmojiPicker = useCallback(() => {
    setShowEmojiPicker((previous) => !previous);
  }, []);

  useEffect(() => {
    if (wasEmojiOpenRef.current && !showEmojiPicker) {
      emojiToggleButtonRef.current?.focus();
    }
    wasEmojiOpenRef.current = showEmojiPicker;
  }, [showEmojiPicker]);

  const handleInsertEmoji = useCallback((emoji) => {
    const textArea = messageInputRef.current;

    if (!textArea) {
      setNewMessage((previous) => `${previous}${emoji}`);
      return;
    }

    const selectionStart = textArea.selectionStart ?? textArea.value.length;
    const selectionEnd = textArea.selectionEnd ?? textArea.value.length;
    const currentValue = textArea.value;

    const nextValue =
      currentValue.slice(0, selectionStart) + emoji + currentValue.slice(selectionEnd);

    setNewMessage(nextValue);

    window.requestAnimationFrame(() => {
      const caretPosition = selectionStart + emoji.length;
      textArea.focus();
      textArea.setSelectionRange(caretPosition, caretPosition);
      textArea.style.height = "auto";
      textArea.style.height = `${Math.min(textArea.scrollHeight, 160)}px`;
    });
  }, []);

  const sendMessagePayload = useCallback(
    async ({ messageContent, messageType = "text" }) => {
      const isDirectMessageLocked =
        Boolean(selectedUser?._id) &&
        (userFollowStatus[selectedUser._id] || "not_following") !== "following";
      const targetConversationId = selectedRoom?._id || selectedUser?._id;

      if (!messageContent || !targetConversationId || isDirectMessageLocked || !currentUserId) {
        return false;
      }

      await axios.post(`${API_BASE_URL}/api/messages/send`, {
        senderUserId: currentUserId,
        receiverUserIdOrRoomId: targetConversationId,
        messageContent,
        messageType,
        replyToMessageId: replyToMessage?._id || null,
      });

      setShowEmojiPicker(false);
      setReplyToMessage(null);
      await fetchMessages();
      return true;
    },
    [currentUserId, fetchMessages, replyToMessage?._id, selectedRoom, selectedUser, userFollowStatus],
  );

  const handleSendMessage = useCallback(async () => {
    const trimmedMessage = newMessage.trim();
    if (!trimmedMessage) {
      return;
    }

    try {
      const sent = await sendMessagePayload({
        messageContent: trimmedMessage,
        messageType: "text",
      });
      if (!sent) {
        return;
      }

      setNewMessage("");

      if (messageInputRef.current) {
        messageInputRef.current.style.height = "auto";
      }
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  }, [newMessage, sendMessagePayload]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (event) => {
      const selectedFile = event.target.files?.[0];
      event.target.value = "";

      if (!selectedFile) {
        return;
      }

      if (selectedFile.size > MAX_ATTACHMENT_SIZE_BYTES) {
        alert(`File is too large. Maximum allowed size is ${formatFileSize(MAX_ATTACHMENT_SIZE_BYTES)}.`);
        return;
      }

      try {
        setIsSendingAttachment(true);

        const dataUrl = await readFileAsDataUrl(selectedFile);
        if (!dataUrl) {
          throw new Error("File payload unavailable");
        }

        const attachmentPayload = JSON.stringify({
          kind: ATTACHMENT_PAYLOAD_KIND,
          name: selectedFile.name || "attachment",
          mimeType: selectedFile.type || "application/octet-stream",
          size: selectedFile.size || 0,
          dataUrl,
        });

        await sendMessagePayload({
          messageContent: attachmentPayload,
          messageType: selectedFile.type.startsWith("image/") ? "image" : "file",
        });
      } catch (error) {
        console.error("Failed to send file:", error);
        alert("Failed to upload file");
      } finally {
        setIsSendingAttachment(false);
      }
    },
    [sendMessagePayload],
  );

  const handleReactToMessage = useCallback(
    async (messageId, emoji) => {
      try {
        const response = await axios.put(`${API_BASE_URL}/api/messages/${messageId}/reactions`, {
          userId: currentUserId,
          emoji,
        });

        const updatedReactions = response.data?.data?.reactions || [];

        setMessages((previous) => {
          let changed = false;
          const next = previous.map((message) => {
            if (String(message._id) !== String(messageId)) {
              return message;
            }
            changed = true;
            return { ...message, reactions: updatedReactions };
          });
          return changed ? next : previous;
        });
      } catch (error) {
        console.error("Failed to update reaction:", error);
      }
    },
    [currentUserId],
  );

  const handleReplyToMessage = useCallback((message) => {
    if (!message?._id) {
      return;
    }

    setReplyToMessage({
      _id: String(message._id),
      senderUserId: message.senderUserId || null,
      messageContent: String(message.messageContent || ""),
      createdAt: message.createdAt || "",
    });
    messageInputRef.current?.focus();
  }, []);

  const handleDeleteMessage = useCallback(
    async (message) => {
      const messageId = message?._id ? String(message._id) : "";
      if (!messageId || !currentUserId) {
        return;
      }

      const shouldDelete = window.confirm("Delete this message?");
      if (!shouldDelete) {
        return;
      }

      try {
        await axios.delete(`${API_BASE_URL}/api/messages/${messageId}`, {
          data: { actorUserId: currentUserId },
        });

        setMessages((previous) =>
          previous
            .filter((existingMessage) => String(existingMessage._id) !== messageId)
            .map((existingMessage) => {
              if (toId(existingMessage.replyTo) === messageId) {
                return { ...existingMessage, replyTo: null };
              }
              return existingMessage;
            }),
        );
        setReplyToMessage((previous) =>
          previous && String(previous._id) === messageId ? null : previous,
        );
      } catch (error) {
        alert(error.response?.data?.message || "Failed to delete message");
      }
    },
    [currentUserId],
  );

  const handleClearActiveConversation = useCallback(async () => {
    const conversationTargetId = selectedRoom?._id || selectedUser?._id;
    if (!conversationTargetId || !currentUserId || isClearingConversation) {
      return;
    }

    const confirmText = selectedRoom
      ? "Delete all messages in this room chat? This will affect all room members."
      : "Delete all messages in this direct chat?";
    const shouldClear = window.confirm(confirmText);
    if (!shouldClear) {
      return;
    }

    try {
      setIsClearingConversation(true);
      await axios.delete(`${API_BASE_URL}/api/messages/conversation/clear`, {
        data: {
          actorUserId: currentUserId,
          receiverUserIdOrRoomId: conversationTargetId,
        },
      });

      setMessages([]);
      setReplyToMessage(null);
      clearUnreadForKey(buildRoomNotificationKey(String(conversationTargetId)));
      clearUnreadForKey(buildDmNotificationKey(String(conversationTargetId)));
    } catch (error) {
      alert(error.response?.data?.message || "Failed to clear conversation");
    } finally {
      setIsClearingConversation(false);
    }
  }, [
    clearUnreadForKey,
    currentUserId,
    isClearingConversation,
    selectedRoom,
    selectedUser,
  ]);

  const handleCreateRoom = useCallback(async () => {
    if (!newRoomName.trim()) {
      return;
    }

    try {
      await axios.post(`${API_BASE_URL}/api/chatrooms/create`, {
        roomName: newRoomName.trim(),
        createdBy: currentUserId,
      });

      setNewRoomName("");
      setShowCreateRoom(false);
      setRoomError("");

      const refreshedRooms = await axios.get(`${API_BASE_URL}/api/chatrooms`, {
        params: { memberId: currentUserId },
      });
      const nextRooms = Array.isArray(refreshedRooms.data) ? refreshedRooms.data : [];
      setRooms(nextRooms.filter((room) => isRoomMember(room, currentUserId)));
    } catch (error) {
      setRoomError(error.response?.data?.message || "Failed to create room");
    }
  }, [currentUserId, newRoomName]);

  const handleAddRoomMember = useCallback(
    async (userId) => {
      if (!selectedRoom?._id || !userId) {
        return;
      }

      try {
        setRoomMemberError("");
        setRoomMemberAction({ type: "add", userId: String(userId) });

        const response = await axios.post(
          `${API_BASE_URL}/api/chatrooms/${selectedRoom._id}/members`,
          {
            userId,
            actorId: currentUserId,
          },
        );

        if (response.data?.room) {
          applyUpdatedRoom(response.data.room);
        }
      } catch (error) {
        setRoomMemberError(error.response?.data?.message || "Failed to add member");
      } finally {
        setRoomMemberAction({ type: "", userId: "" });
      }
    },
    [applyUpdatedRoom, currentUserId, selectedRoom],
  );

  const handleRemoveRoomMember = useCallback(
    async (memberId) => {
      if (!selectedRoom?._id || !memberId) {
        return;
      }

      try {
        setRoomMemberError("");
        setRoomMemberAction({ type: "remove", userId: String(memberId) });

        const response = await axios.delete(
          `${API_BASE_URL}/api/chatrooms/${selectedRoom._id}/members/${memberId}`,
          {
            data: { actorId: currentUserId },
          },
        );

        if (response.data?.room) {
          applyUpdatedRoom(response.data.room);
        }
      } catch (error) {
        setRoomMemberError(error.response?.data?.message || "Failed to remove member");
      } finally {
        setRoomMemberAction({ type: "", userId: "" });
      }
    },
    [applyUpdatedRoom, currentUserId, selectedRoom],
  );

  const handleToggleTheme = useCallback(() => {
    if (propsSetTheme) {
      propsSetTheme((previous) => (previous === "light" ? "dark" : "light"));
      return;
    }

    setLocalTheme((previous) => (previous === "light" ? "dark" : "light"));
  }, [propsSetTheme]);

  const handleLogout = useCallback(async () => {
    endActiveCall({ notifyPeer: true, reason: "logout" });

    try {
      await axios.post(`${API_BASE_URL}/api/users/${currentUserId}/logout`);
    } catch (error) {
      console.error("Logout call failed:", error);
    }

    clearAuthSession();
    window.location.href = "/";
  }, [currentUserId, endActiveCall]);

  const handleProfileUpdate = useCallback(
    (updatedUser) => {
      const normalizedUpdatedUser = normalizeUserForUi(updatedUser || {});
      const nextUserName = normalizedUpdatedUser.username || normalizedUpdatedUser.displayName || "";
      setUserName(nextUserName);
      setCurrentUserProfile((previous) =>
        normalizeUserForUi({
          ...(previous || {}),
          ...normalizedUpdatedUser,
          _id: normalizedUpdatedUser._id || previous?._id || currentUserId,
          username: nextUserName || previous?.username || "",
        }),
      );
      setUsers((previous) =>
        previous.map((user) =>
          String(user._id) === String(normalizedUpdatedUser._id)
            ? normalizeUserForUi({ ...user, ...normalizedUpdatedUser })
            : user,
        ),
      );
      setSelectedUser((previous) =>
        previous && String(previous._id) === String(normalizedUpdatedUser._id)
          ? normalizeUserForUi({ ...previous, ...normalizedUpdatedUser })
          : previous,
      );
      setViewedUser((previous) =>
        previous && String(previous._id) === String(normalizedUpdatedUser._id)
          ? normalizeUserForUi({ ...previous, ...normalizedUpdatedUser })
          : previous,
      );

      if (!currentUserId || !token) {
        return;
      }

      saveAuthSession({
        userId: currentUserId,
        username: nextUserName,
        token,
      });
    },
    [currentUserId, token],
  );

  const openSenderProfile = useCallback((sender) => {
    const senderId = toId(sender);
    if (!senderId) {
      return;
    }

    const normalizedSender =
      typeof sender === "object" ? normalizeUserForUi({ ...sender, _id: senderId }) : normalizeUserForUi({ _id: senderId });
    const matchedUser = usersRef.current.find((user) => String(user._id) === String(senderId));
    const nextViewedUser = matchedUser
      ? normalizeUserForUi({
          ...normalizedSender,
          ...matchedUser,
          _id: senderId,
          avatarUrl: getUserAvatarUrl(matchedUser) || normalizedSender.avatarUrl,
          displayName: matchedUser.displayName || normalizedSender.displayName,
        })
      : normalizedSender;

    setViewedUser(nextViewedUser);
    setShowProfileView(true);
  }, []);

  const selectedRoomMembers = useMemo(() => selectedRoom?.members || [], [selectedRoom]);
  const selectedRoomCreatorId = selectedRoom ? toId(selectedRoom.createdBy) : "";
  const selectedRoomCreatorName = selectedRoom ? getUserDisplayName(selectedRoom.createdBy) : "";
  const isSelectedRoomCreatorById =
    Boolean(selectedRoom?._id) && String(selectedRoomCreatorId) === String(currentUserId);
  const isSelectedRoomCreatorByName =
    Boolean(selectedRoom?._id) &&
    normalizeIdentityText(selectedRoomCreatorName) === normalizeIdentityText(userName);
  const canManageSelectedRoomMembers = isSelectedRoomCreatorById || isSelectedRoomCreatorByName;
  const selectedRoomMemberIdentityKeys = useMemo(
    () =>
      new Set(
        selectedRoomMembers.flatMap((member) => {
          const memberId = String(toId(member));
          const memberName = normalizeIdentityText(getUserDisplayName(member));
          const keys = [];
          if (memberId) {
            keys.push(`id:${memberId}`);
          }
          if (memberName) {
            keys.push(`name:${memberName}`);
          }
          return keys;
        }),
      ),
    [selectedRoomMembers],
  );
  const availableUsersForSelectedRoom = useMemo(
    () =>
      users.filter((user) => {
        const userId = String(toId(user));
        const userNameValue = normalizeIdentityText(getUserDisplayName(user));
        return (
          !selectedRoomMemberIdentityKeys.has(`id:${userId}`) &&
          !selectedRoomMemberIdentityKeys.has(`name:${userNameValue}`)
        );
      }),
    [selectedRoomMemberIdentityKeys, users],
  );

  const activeChatName = selectedRoom?.roomName || selectedUser?.displayName || "";
  const activeChatSubtitle = selectedRoom
    ? `${selectedRoom.members?.length || 0} members`
    : selectedUser?.onlineStatus
      ? "Online"
      : "Offline";
  const activeChatInitial = activeChatName ? activeChatName.charAt(0).toUpperCase() : "#";
  const hasActiveConversation = Boolean(selectedRoom || selectedUser);
  const currentUserAvatarUrl = getUserAvatarUrl(currentUserProfile);
  const activeChatAvatarUrl = selectedRoom ? "" : getUserAvatarUrl(selectedUser);
  const totalUnreadCount = useMemo(
    () => Object.values(unreadCounts).reduce((sum, count) => sum + count, 0),
    [unreadCounts],
  );
  const isCallIdle = callState.status === "idle";
  const callPeerName =
    callState.peerName || resolvePeerName(callState.peerUserId, selectedUser?.displayName || "");
  const callPeerAvatarUrl = useMemo(() => {
    if (selectedUser && String(selectedUser._id) === String(callState.peerUserId)) {
      return getUserAvatarUrl(selectedUser);
    }

    if (callState.peerUserId) {
      const matchedUser = users.find((user) => String(user._id) === String(callState.peerUserId));
      return getUserAvatarUrl(matchedUser);
    }

    return "";
  }, [callState.peerUserId, selectedUser, users]);
  const callStatusLabel = CALL_STATUS_LABELS[callState.status] || "";
  const callHasLocalVideoTrack = Boolean(localStream?.getVideoTracks?.().length);
  const callButtonDisabled = !selectedUser?._id || !isCallIdle;
  const canClearActiveConversation = selectedRoom ? canManageSelectedRoomMembers : Boolean(selectedUser);
  const selectedUserFollowState = selectedUser?._id
    ? userFollowStatus[selectedUser._id] || "not_following"
    : "not_following";
  const canSendDirectMessage = !selectedUser || selectedUserFollowState === "following";
  const messageInputDisabled = Boolean(selectedUser) && !canSendDirectMessage;
  const messageInputPlaceholder = messageInputDisabled
    ? selectedUserFollowState === "pending"
      ? "Follow request pending..."
      : "Follow this user to start messaging"
    : "Type a message...";
  const directMessageRestrictionText = messageInputDisabled
    ? selectedUserFollowState === "pending"
      ? `Your follow request to ${selectedUser?.displayName || "this user"} is pending approval.`
      : `Follow ${selectedUser?.displayName || "this user"} to send direct messages.`
    : "";
  const replyTargetName = useMemo(() => {
    const replySenderId = toId(replyToMessage?.senderUserId);
    if (!replySenderId) {
      return "Unknown";
    }

    if (String(replySenderId) === String(currentUserId)) {
      return "You";
    }

    if (selectedUser && String(selectedUser._id) === String(replySenderId)) {
      return selectedUser.displayName || "Unknown";
    }

    const matchedUser = users.find((user) => String(user._id) === String(replySenderId));
    return matchedUser?.displayName || replyToMessage?.senderUserId?.username || "Unknown";
  }, [currentUserId, replyToMessage, selectedUser, users]);
  const replyTargetPreview = getNotificationPreview(replyToMessage?.messageContent || "Message unavailable");

  const renderSidebarContent = () => {
    if (activeTab === "requests") {
      return <FriendRequests currentUserId={currentUserId} onRequestStatusChange={fetchFollowStatus} />;
    }

    if (activeTab === "people") {
      return users.map((user) => (
        (() => {
          const avatarUrl = getUserAvatarUrl(user);

          return (
            <div key={user._id} className="list-item" style={{ cursor: "default" }}>
              <div className="item-avatar" style={avatarUrl ? { backgroundImage: `url("${avatarUrl}")` } : undefined}>
                {!avatarUrl ? user.displayName?.charAt(0).toUpperCase() : null}
              </div>
              <div className="item-info">
                <div className="item-name">{user.displayName}</div>
                {userFollowStatus[user._id] === "following" ? (
                  <span className="item-status" style={{ color: "var(--success-color)" }}>
                    Following
                  </span>
                ) : (
                  <button
                    className="icon-btn"
                    style={{ fontSize: "0.8rem", padding: "2px 8px", border: "1px solid var(--sidebar-border)" }}
                    onClick={async (event) => {
                      event.stopPropagation();
                      try {
                        await axios.post(`${API_BASE_URL}/api/users/${currentUserId}/follow-request/${user._id}`);
                        fetchFollowStatus();
                      } catch {
                        alert("Failed to follow");
                      }
                    }}
                  >
                    {userFollowStatus[user._id] === "pending" ? "Pending" : "Follow"}
                  </button>
                )}
              </div>
            </div>
          );
        })()
      ));
    }

    return (
      <>
        {showCreateRoom && (
          <div className="create-form">
            <input
              className="text-input"
              placeholder="Room Name"
              value={newRoomName}
              onChange={(event) => setNewRoomName(event.target.value)}
            />
            {roomError && <p className="room-error">{roomError}</p>}
            <button className="primary-btn" onClick={handleCreateRoom}>
              Create
            </button>
          </div>
        )}

        <div className="list-header">Rooms</div>
        {rooms.map((room) => (
          (() => {
            const roomNotificationKey = buildRoomNotificationKey(String(room._id));
            const roomUnreadCount = unreadCounts[roomNotificationKey] || 0;

            return (
              <div
                key={room._id}
                className={`list-item ${selectedRoom?._id === room._id ? "active" : ""}`}
                onClick={() => {
                  clearUnreadForKey(roomNotificationKey);
                  setSelectedRoom(room);
                  setSelectedUser(null);
                  setShowEmojiPicker(false);
                  setRoomMemberError("");
                  setRoomMemberAction({ type: "", userId: "" });
                }}
              >
                <div className="item-avatar">#</div>
                <div className="item-info">
                  <div className="item-name">{room.roomName}</div>
                  <div className="item-status-row">
                    <div className="item-status">{room.members?.length || 0} members</div>
                    {roomUnreadCount > 0 && (
                      <span className="unread-badge">{roomUnreadCount > 99 ? "99+" : roomUnreadCount}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })()
        ))}

        <div className="list-header" style={{ marginTop: "1rem" }}>
          Direct Messages
        </div>
        {users.map((user) => (
          (() => {
            const userNotificationKey = buildDmNotificationKey(String(user._id));
            const userUnreadCount = unreadCounts[userNotificationKey] || 0;
            const userAvatarUrl = getUserAvatarUrl(user);

            return (
              <div
                key={user._id}
                className={`list-item ${selectedUser?._id === user._id ? "active" : ""}`}
                onClick={() => {
                  clearUnreadForKey(userNotificationKey);
                  setSelectedUser(user);
                  setSelectedRoom(null);
                  setShowEmojiPicker(false);
                  setShowRoomInfo(false);
                  setRoomMemberError("");
                  setRoomMemberAction({ type: "", userId: "" });
                }}
              >
                <div className="item-info item-info--dm">
                  <button
                    className="item-avatar item-avatar-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      openSenderProfile(user);
                    }}
                    aria-label={`View ${user.displayName} profile`}
                    title="View profile"
                    style={userAvatarUrl ? { backgroundImage: `url("${userAvatarUrl}")` } : undefined}
                  >
                    {!userAvatarUrl ? user.displayName?.charAt(0).toUpperCase() : null}
                  </button>
                  <div className="item-copy">
                    <div className="item-name">{user.displayName}</div>
                    <div className="item-status item-status--dm">
                      <span className={`item-status-dot ${user.onlineStatus ? "online" : "offline"}`} />
                      {user.onlineStatus ? "Online" : "Offline"}
                    </div>
                  </div>
                </div>
                {userUnreadCount > 0 && (
                  <span className="unread-badge">{userUnreadCount > 99 ? "99+" : userUnreadCount}</span>
                )}
              </div>
            );
          })()
        ))}
      </>
    );
  };

  return (
    <div className={`chat-container ${hasActiveConversation ? "chat-open" : ""}`}>
      <div className="chat-sidebar">
        <div className="sidebar-header">
          <h2>ChatApp</h2>
          <div className="header-actions">
            <button
              className="icon-btn header-icon-btn"
              onClick={handleToggleTheme}
              title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
              aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            >
              <ThemeIcon theme={theme} />
            </button>
            <button
              className="icon-btn danger header-icon-btn"
              onClick={handleLogout}
              title="Logout"
              aria-label="Logout"
            >
              <LogoutIcon />
            </button>
          </div>
        </div>

        <div className="user-profile-mini">
          <div
            className="user-info-group"
            onClick={() => setShowProfileEdit(true)}
            style={{ cursor: "pointer" }}
            title="Edit Profile"
          >
            <div
              className="user-avatar-mini"
              style={currentUserAvatarUrl ? { backgroundImage: `url("${currentUserAvatarUrl}")` } : undefined}
            >
              {!currentUserAvatarUrl ? userName?.charAt(0).toUpperCase() : null}
            </div>
            <div className="user-name-mini">{userName}</div>
          </div>
          <button
            className="new-room-btn-small"
            onClick={() => setShowCreateRoom((previous) => !previous)}
            title="Create New Room"
            aria-label="Create New Room"
          >
            +
          </button>
        </div>

        <div className="sidebar-tabs">
          <button className={`tab-btn ${activeTab === "chats" ? "active" : ""}`} onClick={() => setActiveTab("chats")}>
            Chats
            {totalUnreadCount > 0 && (
              <span className="tab-unread-badge">{totalUnreadCount > 99 ? "99+" : totalUnreadCount}</span>
            )}
          </button>
          <button className={`tab-btn ${activeTab === "people" ? "active" : ""}`} onClick={() => setActiveTab("people")}>
            People
          </button>
          <button
            className={`tab-btn ${activeTab === "requests" ? "active" : ""}`}
            onClick={() => setActiveTab("requests")}
          >
            Requests
          </button>
        </div>

        <div className="sidebar-content">{isLoading ? <div className="empty-state">Loading...</div> : renderSidebarContent()}</div>
      </div>

      {hasActiveConversation ? (
        <div className="chat-main has-chat">
          <div
            className="chat-header"
            onClick={() => {
              if (selectedUser) {
                setViewedUser(selectedUser);
                setShowProfileView(true);
              }
            }}
            style={{ cursor: selectedUser ? "pointer" : "default" }}
            title={selectedUser ? "View Profile" : ""}
          >
            <div className="chat-user">
              <button
                className="icon-btn mobile-back-btn"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedRoom(null);
                  setSelectedUser(null);
                  setMessages([]);
                  setShowEmojiPicker(false);
                  setShowRoomInfo(false);
                }}
                aria-label="Back to conversations"
                title="Back to conversations"
              >
                &#8592;
              </button>
              <div className="chat-user-avatar">
                {activeChatAvatarUrl ? (
                  <img
                    src={activeChatAvatarUrl}
                    alt={`${activeChatName || "User"} avatar`}
                    className="chat-user-avatar-image"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}
                {selectedRoom ? "#" : activeChatInitial}
              </div>
              <div className="chat-user-meta">
                <h2>{activeChatName}</h2>
                <p>{activeChatSubtitle}</p>
              </div>
            </div>
            <div className="chat-actions">
              {(selectedRoom || selectedUser) && (
                <button
                  className="icon-btn danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleClearActiveConversation();
                  }}
                  title={
                    selectedRoom && !canClearActiveConversation
                      ? "Only room creator can clear this chat"
                      : "Delete all messages in this chat"
                  }
                  aria-label="Delete all messages in this chat"
                  disabled={isClearingConversation || !canClearActiveConversation}
                >
                  {isClearingConversation ? "..." : "Clear"}
                </button>
              )}
              {selectedUser && (
                <>
                  <button
                    className="icon-btn call-action-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleStartCall("audio");
                    }}
                    title="Start voice call"
                    aria-label="Start voice call"
                    disabled={callButtonDisabled}
                  >
                    <PhoneIcon />
                  </button>
                  <button
                    className="icon-btn call-action-btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleStartCall("video");
                    }}
                    title="Start video call"
                    aria-label="Start video call"
                    disabled={callButtonDisabled}
                  >
                    <VideoIcon />
                  </button>
                </>
              )}
              {selectedRoom && (
                <button
                  className="icon-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    setRoomMemberError("");
                    setShowRoomInfo(true);
                    setRoomMemberAction({ type: "", userId: "" });
                  }}
                >
                  Info
                </button>
              )}
            </div>
          </div>

          <div className="messages-container whatsapp-scroll">
            {messages.map((message) => (
              <MessageItem
                key={message._id}
                message={message}
                currentUserId={currentUserId}
                onReact={handleReactToMessage}
                onOpenSenderProfile={openSenderProfile}
                onReply={handleReplyToMessage}
                onDelete={handleDeleteMessage}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-area">
            {replyToMessage && (
              <div className="reply-composer-banner" role="status" aria-live="polite">
                <div className="reply-composer-copy">
                  <span className="reply-composer-label">Replying to {replyTargetName}</span>
                  <span className="reply-composer-text">{replyTargetPreview}</span>
                </div>
                <button
                  type="button"
                  className="reply-composer-cancel"
                  onClick={() => setReplyToMessage(null)}
                  aria-label="Cancel reply"
                >
                  Cancel
                </button>
              </div>
            )}

            <div className="input-wrapper">
              <div className="emoji-trigger" ref={emojiTriggerWrapRef}>
                <button
                  ref={emojiToggleButtonRef}
                  className="icon-btn emoji-open-btn"
                  type="button"
                  onClick={toggleEmojiPicker}
                  disabled={messageInputDisabled || isSendingAttachment}
                  aria-label="Open emoji picker"
                  aria-expanded={showEmojiPicker}
                >
                  <EmojiIcon />
                </button>
                <EmojiPickerPanel
                  isOpen={showEmojiPicker}
                  theme={theme}
                  anchorRef={emojiTriggerWrapRef}
                  onClose={closeEmojiPicker}
                  onEmojiSelect={handleInsertEmoji}
                />
              </div>

              <button
                className="icon-btn upload-file-btn"
                type="button"
                onClick={openFilePicker}
                disabled={messageInputDisabled || isSendingAttachment}
                aria-label="Upload file"
                title="Upload file"
              >
                <AttachmentIcon />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="chat-file-input"
                onChange={handleFileSelected}
                disabled={messageInputDisabled || isSendingAttachment}
                hidden
                tabIndex={-1}
                accept=".pdf,.doc,.docx,.txt,.rtf,.odt,.xls,.xlsx,.ppt,.pptx,image/*"
              />

              <textarea
                ref={messageInputRef}
                className="chat-input"
                placeholder={messageInputPlaceholder}
                value={newMessage}
                rows={1}
                disabled={messageInputDisabled}
                onChange={(event) => setNewMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSendMessage();
                  }
                }}
              />

              <button
                className="send-btn"
                onClick={handleSendMessage}
                disabled={!newMessage.trim() || messageInputDisabled || isSendingAttachment}
              >
                Send
              </button>
            </div>
            {directMessageRestrictionText && <p className="chat-input-note">{directMessageRestrictionText}</p>}
          </div>
        </div>
      ) : (
        <div className="chat-main">
          <div className="no-chat">
            <div className="no-chat-icon">
              <ChatIcon />
            </div>
            <h2>Select a chat to start messaging</h2>
          </div>
        </div>
      )}

      {!isCallIdle && (
        <div className="call-overlay" role="dialog" aria-modal="false" aria-label="Call panel">
          <div className={`call-panel ${callState.callType === "video" ? "video-mode" : "audio-mode"}`}>
            <div className="call-panel-head">
              <div className="call-panel-meta">
                <h3>{callPeerName}</h3>
                <p>{callStatusLabel}</p>
              </div>
            </div>

            <div className={`call-media ${callState.callType === "video" ? "video-mode" : "audio-mode"}`}>
              {callState.callType === "video" ? (
                <>
                  <video ref={remoteVideoRef} className="call-remote-video" autoPlay playsInline />
                  <video ref={localVideoRef} className="call-local-video" autoPlay muted playsInline />
                </>
              ) : (
                <div
                  className="call-audio-avatar"
                  style={callPeerAvatarUrl ? { backgroundImage: `url("${callPeerAvatarUrl}")` } : undefined}
                >
                  {!callPeerAvatarUrl ? callPeerName?.charAt(0)?.toUpperCase() || "?" : null}
                </div>
              )}
              <audio ref={remoteAudioRef} autoPlay />
            </div>

            <div className="call-controls">
              {callState.status === "incoming" ? (
                <>
                  <button className="primary-btn call-control-btn" onClick={handleAcceptIncomingCall}>
                    Accept
                  </button>
                  <button className="icon-btn danger call-control-btn" onClick={handleDeclineIncomingCall}>
                    Decline
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={`icon-btn call-control-btn ${isMicMuted ? "active" : ""}`}
                    onClick={handleToggleMute}
                  >
                    {isMicMuted ? "Unmute" : "Mute"}
                  </button>
                  {callState.callType === "video" && (
                    <button
                      className={`icon-btn call-control-btn ${isCameraOff ? "active" : ""}`}
                      onClick={handleToggleCamera}
                      disabled={!callHasLocalVideoTrack}
                    >
                      {isCameraOff ? "Camera On" : "Camera Off"}
                    </button>
                  )}
                  <button
                    className="icon-btn danger call-control-btn"
                    onClick={() => endActiveCall({ notifyPeer: true, reason: "ended" })}
                  >
                    End
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {callState.error && <div className="call-error-banner" role="status">{callState.error}</div>}

      {selectedRoom && showRoomInfo && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowRoomInfo(false);
            setRoomMemberError("");
            setRoomMemberAction({ type: "", userId: "" });
          }}
        >
          <div className="modal room-info-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header room-info-header">
              <h3>Room Info</h3>
              <button
                className="icon-btn room-info-close-btn"
                onClick={() => {
                  setShowRoomInfo(false);
                  setRoomMemberError("");
                  setRoomMemberAction({ type: "", userId: "" });
                }}
              >
                X
              </button>
            </div>
            <div className="modal-body room-info-modal-body">
              <div className="room-info-hero">
                <div className="room-info-avatar">{selectedRoom.roomName?.charAt(0)?.toUpperCase() || "#"}</div>
                <div className="room-info-hero-copy">
                  <p className="room-info-kicker">Room</p>
                  <h4>{selectedRoom.roomName}</h4>
                  <p>
                    {selectedRoomMembers.length} members - Created by {selectedRoomCreatorName}
                  </p>
                </div>
              </div>

              <div className="room-info-stats">
                <div className="room-info-stat">
                  <span>Total Members</span>
                  <strong>{selectedRoomMembers.length}</strong>
                </div>
                <div className="room-info-stat">
                  <span>Your Role</span>
                  <strong>{canManageSelectedRoomMembers ? "Creator" : "Member"}</strong>
                </div>
              </div>

              {roomMemberError && <p className="room-error">{roomMemberError}</p>}

              <div className="room-members-section">
                <div className="room-members-head">
                  <h4>
                    Current Members <span className="room-count-pill">{selectedRoomMembers.length}</span>
                  </h4>
                  {!canManageSelectedRoomMembers && (
                    <span className="room-member-note">Only creator can manage members</span>
                  )}
                </div>

                <div className="room-members-list">
                  {selectedRoomMembers.map((member, index) => {
                    const memberId = toId(member);
                    const memberName = getUserDisplayName(member);
                    const isCreator =
                      (Boolean(memberId) &&
                        Boolean(selectedRoomCreatorId) &&
                        String(memberId) === String(selectedRoomCreatorId)) ||
                      normalizeIdentityText(memberName) === normalizeIdentityText(selectedRoomCreatorName);
                    const isRemoving =
                      roomMemberAction.type === "remove" && roomMemberAction.userId === memberId;
                    const canRemoveMember =
                      canManageSelectedRoomMembers && !isCreator && Boolean(memberId);

                    return (
                      <div
                        key={`room-member-${memberId || normalizeIdentityText(memberName) || index}`}
                        className="room-member-row"
                      >
                        <div className="room-member-meta">
                          <div className="room-member-avatar">
                            {memberName.charAt(0).toUpperCase()}
                          </div>
                          <div className="room-member-copy">
                            <div className="room-member-name">{memberName}</div>
                            <div className="room-member-status">
                              {isCreator ? "Creator" : member.onlineStatus ? "Online" : "Offline"}
                            </div>
                          </div>
                        </div>

                        {isCreator ? (
                          <span className="room-member-badge">Creator</span>
                        ) : canManageSelectedRoomMembers ? (
                          <button
                            className="icon-btn room-member-remove-btn"
                            onClick={() => {
                              if (canRemoveMember) {
                                handleRemoveRoomMember(memberId);
                              }
                            }}
                            disabled={isRemoving || !canRemoveMember}
                            title={!memberId ? "Unable to remove this member." : "Remove member"}
                          >
                            {isRemoving ? "Removing..." : "Remove"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="room-members-section">
                <div className="room-members-head">
                  <h4>Add Existing Members</h4>
                  {!canManageSelectedRoomMembers && (
                    <span className="room-member-note">Only creator can manage members</span>
                  )}
                </div>

                {availableUsersForSelectedRoom.length === 0 ? (
                  <p className="empty-state room-empty-state">All available users are already in this room.</p>
                ) : (
                  <div className="room-add-list">
                    {availableUsersForSelectedRoom.map((user) => {
                      const userId = toId(user);
                      const userNameValue = getUserDisplayName(user);
                      const isAdding =
                        roomMemberAction.type === "add" && roomMemberAction.userId === userId;
                      const canAddMember = canManageSelectedRoomMembers && Boolean(userId);

                      return (
                        <div
                          key={`add-user-${userId || normalizeIdentityText(userNameValue)}`}
                          className="room-member-row"
                        >
                          <div className="room-member-meta">
                            <div className="room-member-avatar">
                              {userNameValue.charAt(0).toUpperCase()}
                            </div>
                            <div className="room-member-copy">
                              <div className="room-member-name">{userNameValue}</div>
                              <div className="room-member-status">
                                {user.onlineStatus ? "Online" : "Offline"}
                              </div>
                            </div>
                          </div>

                          <button
                            className="primary-btn room-member-add-btn"
                            onClick={() => {
                              if (canAddMember) {
                                handleAddRoomMember(userId);
                              }
                            }}
                            disabled={!canAddMember || isAdding}
                          >
                            {isAdding ? "Adding..." : "Add"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showProfileEdit && (
        <ProfileEditModal
          user={{
            _id: currentUserId,
            username: currentUserProfile?.username || userName || "",
            bio: currentUserProfile?.bio || "",
            avatarUrl: currentUserAvatarUrl,
            phoneNumber: currentUserProfile?.phoneNumber || "",
            email: currentUserProfile?.email || "",
          }}
          onClose={() => setShowProfileEdit(false)}
          onUpdate={handleProfileUpdate}
        />
      )}

      {showProfileView && viewedUser && (
        <ProfileViewModal
          user={viewedUser}
          onClose={() => {
            setShowProfileView(false);
            setViewedUser(null);
          }}
        />
      )}
    </div>
  );
}

export default ChatPage;
