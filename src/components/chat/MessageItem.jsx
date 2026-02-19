import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactionBar from "./ReactionBar";

const LONG_PRESS_MS = 420;
const ATTACHMENT_PAYLOAD_KIND = "chat_attachment";

function getUserId(user) {
  if (!user) {
    return "";
  }

  if (typeof user === "string") {
    return user;
  }

  return user._id || "";
}

function buildReactionSummary(reactions, currentUserId) {
  const aggregate = new Map();

  reactions.forEach((reaction) => {
    const key = reaction.emoji;
    const entry = aggregate.get(key) || { emoji: key, count: 0, reactedByMe: false };
    entry.count += 1;
    if (getUserId(reaction.user) === currentUserId) {
      entry.reactedByMe = true;
    }
    aggregate.set(key, entry);
  });

  return Array.from(aggregate.values());
}

function parseAttachmentPayload(rawContent) {
  const text = String(rawContent || "").trim();
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

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
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

function getMessageTextPreview(content, maxLength = 120) {
  const text = String(content || "").trim();
  if (!text) {
    return "Message unavailable";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function MessageItem({ message, currentUserId, onReact, onOpenSenderProfile, onReply, onDelete }) {
  const [showReactionBar, setShowReactionBar] = useState(false);
  const longPressTimerRef = useRef(null);
  const messageRef = useRef(null);

  const senderId = getUserId(message.senderUserId);
  const isMine = senderId === currentUserId || senderId === "";
  const senderName = message.senderUserId?.username || "Unknown";
  const replyMessage = message.replyTo && typeof message.replyTo === "object" ? message.replyTo : null;
  const replySenderId = getUserId(replyMessage?.senderUserId);
  const replySenderName = replySenderId === currentUserId ? "You" : replyMessage?.senderUserId?.username || "Unknown";
  const attachmentPayload = useMemo(() => {
    if (message.messageType !== "image" && message.messageType !== "file") {
      return null;
    }

    return parseAttachmentPayload(message.messageContent);
  }, [message.messageContent, message.messageType]);
  const isImageAttachment = Boolean(attachmentPayload?.mimeType?.startsWith("image/"));
  const attachmentSizeLabel = useMemo(
    () => formatFileSize(attachmentPayload?.size || 0),
    [attachmentPayload?.size],
  );
  const replyPreviewText = useMemo(() => {
    const replyAttachment = parseAttachmentPayload(replyMessage?.messageContent);
    if (replyAttachment) {
      const label = replyAttachment.mimeType?.startsWith("image/") ? "Image" : "File";
      return `${label}: ${replyAttachment.name}`;
    }

    return getMessageTextPreview(replyMessage?.messageContent, 90);
  }, [replyMessage?.messageContent]);

  const myReaction = useMemo(() => {
    return (message.reactions || []).find((reaction) => getUserId(reaction.user) === currentUserId)?.emoji || null;
  }, [currentUserId, message.reactions]);

  const reactionSummary = useMemo(() => {
    return buildReactionSummary(message.reactions || [], currentUserId);
  }, [currentUserId, message.reactions]);

  const onReactionSelect = useCallback(
    (emoji) => {
      onReact(message._id, emoji);
      setShowReactionBar(false);
    },
    [message._id, onReact],
  );

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearLongPress();
    };
  }, [clearLongPress]);

  useEffect(() => {
    if (!showReactionBar) {
      return undefined;
    }

    const closeIfOutside = (event) => {
      if (messageRef.current?.contains(event.target)) {
        return;
      }
      setShowReactionBar(false);
    };

    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setShowReactionBar(false);
      }
    };

    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("contextmenu", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("contextmenu", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showReactionBar]);

  const onTouchStart = useCallback(() => {
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      setShowReactionBar(true);
    }, LONG_PRESS_MS);
  }, [clearLongPress]);

  const onTouchEnd = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  return (
    <article
      ref={messageRef}
      className={`message wa-message ${isMine ? "sent" : "received"}`}
      onContextMenu={(event) => {
        event.preventDefault();
        setShowReactionBar(true);
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchMove={clearLongPress}
      onTouchCancel={clearLongPress}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setShowReactionBar(false);
        }
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          setShowReactionBar(true);
        }
      }}
      tabIndex={0}
      role="group"
      aria-label={`Message from ${isMine ? "you" : senderName}`}
    >
      {!isMine && (
        <button
          type="button"
          className="msg-sender msg-sender-button"
          onClick={() => onOpenSenderProfile?.(message.senderUserId)}
          aria-label={`Open ${senderName} profile`}
        >
          {senderName}
        </button>
      )}

      <div className="msg-bubble">
        <div className="glass-reflex" aria-hidden="true" />
        {replyMessage && (
          <div className="msg-reply-quote" aria-label={`Reply to ${replySenderName}`}>
            <span className="msg-reply-sender">{replySenderName}</span>
            <span className="msg-reply-text">{replyPreviewText}</span>
          </div>
        )}
        {attachmentPayload ? (
          <div className={`msg-attachment ${isImageAttachment ? "image" : "file"}`}>
            {isImageAttachment && (
              <a
                className="msg-attachment-image-link"
                href={attachmentPayload.dataUrl}
                download={attachmentPayload.name}
                aria-label={`Open ${attachmentPayload.name}`}
              >
                <img
                  src={attachmentPayload.dataUrl}
                  alt={attachmentPayload.name}
                  className="msg-attachment-image"
                  loading="lazy"
                />
              </a>
            )}

            <div className="msg-attachment-meta">
              <span className="msg-attachment-name">{attachmentPayload.name}</span>
              {attachmentSizeLabel && (
                <span className="msg-attachment-size">{attachmentSizeLabel}</span>
              )}
              <a
                className="msg-attachment-download"
                href={attachmentPayload.dataUrl}
                download={attachmentPayload.name}
              >
                Download
              </a>
            </div>
          </div>
        ) : (
          message.messageContent
        )}
        <span className="msg-time">
          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>

      <div className={`wa-message-actions ${showReactionBar ? "visible" : ""} ${isMine ? "mine" : "theirs"}`}>
        <ReactionBar visible={showReactionBar} activeEmoji={myReaction} onSelect={onReactionSelect} />
        {showReactionBar && (
          <button
            type="button"
            className="wa-reply-action"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              onReply?.(message);
              setShowReactionBar(false);
            }}
            aria-label="Reply to message"
            title="Reply"
          >
            Reply
          </button>
        )}
        {showReactionBar && onDelete && (
          <button
            type="button"
            className="wa-delete-action"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              onDelete?.(message);
              setShowReactionBar(false);
            }}
            aria-label="Delete message"
            title="Delete message"
          >
            Delete
          </button>
        )}
      </div>

      {reactionSummary.length > 0 && (
        <div className="wa-reaction-summary" role="group" aria-label="Message reactions">
          {reactionSummary.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              className={`wa-reaction-chip ${reaction.reactedByMe ? "mine" : ""}`}
              onClick={() => onReactionSelect(reaction.emoji)}
              aria-label={`Reaction ${reaction.emoji} with count ${reaction.count}`}
            >
              <span>{reaction.emoji}</span>
              <span>{reaction.count}</span>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

const MemoMessageItem = memo(
  MessageItem,
  (prevProps, nextProps) =>
    prevProps.message === nextProps.message &&
    prevProps.currentUserId === nextProps.currentUserId &&
    prevProps.onReact === nextProps.onReact &&
    prevProps.onOpenSenderProfile === nextProps.onOpenSenderProfile &&
    prevProps.onReply === nextProps.onReply &&
    prevProps.onDelete === nextProps.onDelete,
);

export default MemoMessageItem;
