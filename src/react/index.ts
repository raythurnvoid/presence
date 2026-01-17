"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useConvex } from "convex/react";
import type { FunctionReference } from "convex/server";
import useSingleFlight from "./useSingleFlight.js";

// Interface in your Convex app /convex directory that implements these
// functions by calling into the presence component, e.g., like this:
//
// export const presence = new Presence(components.presence);
//
// export const heartbeat = mutation({
//   args: { roomId: v.string(), userId: v.string(), sessionId: v.string(), interval: v.number() },
//   handler: async (ctx, { roomId, userId, sessionId, interval }) => {
//     // TODO: Add your auth checks here.
//     return await presence.heartbeat(ctx, roomId, userId, sessionId, interval);
//   },
// });
//
// export const list = query({
//   args: { roomToken: v.string() },
//   handler: async (ctx, { roomToken }) => {
//     // Avoid adding per-user reads so all subscriptions can share same cache.
//     return await presence.list(ctx, roomToken);
//   },
// });
//
// export const disconnect = mutation({
//   args: { sessionToken: v.string() },
//   handler: async (ctx, { sessionToken }) => {
//     // Can't check auth here because it's called over http from sendBeacon.
//     return await presence.disconnect(ctx, sessionToken);
//   },
// });
export interface PresenceAPI {
  heartbeat: FunctionReference<
    "mutation",
    "public",
    { roomId: string; userId: string; sessionId: string; interval: number },
    { roomToken: string; sessionToken: string }
  >;
  disconnect: FunctionReference<"mutation", "public", { sessionToken: string }>;
}

// React hook for maintaining presence state.
//
// This hook is designed to be efficient and only sends a message to users
// whenever a member joins or leaves the room, not on every heartbeat.
//
// Use of this hook requires passing in a reference to the Convex presence
// component defined in your Convex app. See ../../example/src/App.tsx for an
// example of how to incorporate this hook into your application.
export type UsePresenceOptions = {
  presence: PresenceAPI;
  roomId: string;
  userId: string;
  interval?: number;
  convexUrl?: string;
  /**
   * Optional auth token getter for the HTTP disconnect call on page unload.
   *
   * This is needed because `navigator.sendBeacon` cannot set `Authorization` headers,
   * so `fetch(..., { keepalive: true })` is used instead.
   */
  getAuthToken?: () => string | null;
  /**
   * @default true
   */
  disconnectOnDocumentHidden?: boolean;
};

export function usePresence(options: UsePresenceOptions) {
  const {
    presence,
    roomId,
    userId,
    interval = 10000,
    convexUrl,
    getAuthToken,
    disconnectOnDocumentHidden = true,
  } = options;
  const hasMounted = useRef(false);
  const convex = useConvex();
  const baseUrl = convexUrl ?? convex.url;

  // Each session (browser tab etc) has a unique ID and a token used to disconnect it.
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [sessionToken, setSessionToken] = useState<string | undefined>(undefined);
  const sessionTokenRef = useRef<string | undefined>(undefined);

  const [roomToken, setRoomToken] = useState<string | undefined>(undefined);
  const roomTokenRef = useRef<string | undefined>(undefined);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const heartbeat = useSingleFlight(useMutation(presence.heartbeat));
  const disconnect = useSingleFlight(useMutation(presence.disconnect));

  const firstHeartBeatDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const oldRoomIdRef = useRef(roomId);
  const oldUserIdRef = useRef(userId);

  useEffect(() => {
    if (oldRoomIdRef.current === roomId && oldUserIdRef.current === userId) return;

    // Reset session state when roomId or userId changes.
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (sessionTokenRef.current) {
      void disconnect({ sessionToken: sessionTokenRef.current });
    }
    setSessionId(crypto.randomUUID());
    setSessionToken(undefined);
    setRoomToken(undefined);

    oldRoomIdRef.current = roomId;
    oldUserIdRef.current = userId;
  }, [roomId, userId, disconnect]);

  useEffect(() => {
    // Update refs whenever tokens change.
    sessionTokenRef.current = sessionToken;
    roomTokenRef.current = roomToken;
  }, [sessionToken, roomToken]);

  useEffect(() => {
    if (!sessionId) return;

    // Periodic heartbeats.
    const sendHeartbeat = async () => {
      const result = await heartbeat({ roomId, userId, sessionId, interval });
      setRoomToken(result.roomToken);
      setSessionToken(result.sessionToken);
    };

    // Send initial heartbeat
    firstHeartBeatDebounce.current = setTimeout(() => {
      void sendHeartbeat();
    });

    // Clear any existing interval before setting a new one
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    intervalRef.current = setInterval(sendHeartbeat, interval);

    // Handle page unload.
    const handleUnload = () => {
      if (sessionTokenRef.current) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        const authToken = getAuthToken?.();
        if (authToken) {
          headers["Authorization"] = `Bearer ${authToken}`;
        }

        fetch(`${baseUrl}/api/mutation`, {
          method: "POST",
          keepalive: true,
          headers,
          body: JSON.stringify({
            path: "presence:disconnect",
            args: { sessionToken: sessionTokenRef.current },
          }),
        }).catch((e) => console.error('[usePresence.handleUnload] error:', e));
      }
    };
    window.addEventListener("beforeunload", handleUnload);

    // Handle visibility changes.
    const handleVisibility = async () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (disconnectOnDocumentHidden && sessionTokenRef.current) {
          await disconnect({ sessionToken: sessionTokenRef.current });
        }
      } else {
        void sendHeartbeat();
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
        intervalRef.current = setInterval(sendHeartbeat, interval);
      }
    };
    const wrappedHandleVisibility = () => {
      handleVisibility().catch(console.error);
    };
    document.addEventListener("visibilitychange", wrappedHandleVisibility);

    // Cleanup.
    return () => {
      if (firstHeartBeatDebounce.current) {
        clearTimeout(firstHeartBeatDebounce.current);
      }

      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      document.removeEventListener("visibilitychange", wrappedHandleVisibility);
      window.removeEventListener("beforeunload", handleUnload);
      // Don't disconnect on first render in strict mode.
      if (hasMounted.current) {
        if (sessionTokenRef.current) {
          void disconnect({ sessionToken: sessionTokenRef.current });
        }
      }
    };
  }, [heartbeat, disconnect, roomId, userId, baseUrl, interval, sessionId]);

  useEffect(() => {
    hasMounted.current = true;
  }, []);

  return {
    roomToken,
    sessionId,
    sessionToken,
  };
}
