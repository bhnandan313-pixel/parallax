export const PLAYBACK_STATES = Object.freeze(['playing', 'paused', 'stopped']);
export const TRANSITIONS = Object.freeze(['none', 'fade', 'slide-left', 'slide-right']);
export const PLAYBACK_START_DELAY_MS = 1500;
export const PLAYBACK_DRIFT_THRESHOLD_SECONDS = 0.3;
export const DEFAULT_PLAYBACK_VOLUME = 0;

export function getPlaybackPosition(playback, now = Date.now()) {
    if (!playback || playback.status !== 'playing' || !Number.isFinite(playback.startedAt)) {
        return Math.max(0, Number(playback?.positionSeconds) || 0);
    }
    return Math.max(0, playback.positionSeconds
        + Math.max(0, now - playback.startedAt) / 1000);
}

export function createPlaybackTimeline(playback, serverNow = Date.now()) {
    return {
        status: playback.status,
        mediaId: playback.mediaId ?? null,
        positionSeconds: Math.max(0, Number(playback.positionSeconds) || 0),
        startedAt: playback.status === 'playing' ? playback.startedAt : null,
        serverNow,
        timelineId: playback.timelineId ?? null,
        playlistId: playback.playlistId ?? null,
        playlistIndex: playback.playlistIndex ?? 0,
        nextPlaylistIndex: playback.nextPlaylistIndex ?? null,
        transition: TRANSITIONS.includes(playback.transition) ? playback.transition : 'none',
        volume: Number.isFinite(playback.volume)
            ? Math.min(1, Math.max(0, playback.volume))
            : DEFAULT_PLAYBACK_VOLUME
    };
}

export function expectedPlaybackPosition(timeline, serverNow = Date.now()) {
    if (!timeline || timeline.status !== 'playing' || !Number.isFinite(timeline.startedAt)) {
        return Math.max(0, Number(timeline?.positionSeconds) || 0);
    }
    return Math.max(0, timeline.positionSeconds
        + Math.max(0, serverNow - timeline.startedAt) / 1000);
}

export function getPlaybackDrift(currentSeconds, timeline, serverNow = Date.now()) {
    if (!Number.isFinite(currentSeconds)) {
        return null;
    }
    return expectedPlaybackPosition(timeline, serverNow) - currentSeconds;
}

export function shouldCorrectPlaybackDrift(
    currentSeconds,
    timeline,
    serverNow = Date.now(),
    thresholdSeconds = PLAYBACK_DRIFT_THRESHOLD_SECONDS
) {
    const drift = getPlaybackDrift(currentSeconds, timeline, serverNow);
    return drift !== null && Math.abs(drift) > thresholdSeconds;
}

export function getPlaylistItem(playlist, index) {
    if (!playlist || !Array.isArray(playlist.items) || playlist.items.length === 0) {
        return null;
    }
    const normalized = playlist.loop
        ? ((index % playlist.items.length) + playlist.items.length) % playlist.items.length
        : Math.min(Math.max(0, index), playlist.items.length - 1);
    return { item: playlist.items[normalized], index: normalized };
}
