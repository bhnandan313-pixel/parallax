import {
    expectedPlaybackPosition,
    PLAYBACK_DRIFT_THRESHOLD_SECONDS
} from './playback.js';

export function synchronizePreviewVideo(video, timeline, serverNow = Date.now()) {
    if (!video || !timeline
        || !['playing', 'paused', 'stopped'].includes(timeline.status)
        || !Number.isFinite(timeline.positionSeconds)
        || !Number.isFinite(serverNow)) {
        return false;
    }

    const target = expectedPlaybackPosition(timeline, serverNow);
    if (video.readyState < 1) {
        return false;
    }
    if (Math.abs(video.currentTime - target) > PLAYBACK_DRIFT_THRESHOLD_SECONDS) {
        video.currentTime = target;
    }

    if (timeline.status !== 'playing'
        || (Number.isFinite(timeline.startedAt) && serverNow < timeline.startedAt)) {
        video.pause();
        return true;
    }
    if (video.readyState < 2) {
        video.pause();
        return false;
    }
    if (video.paused) {
        return video.play();
    }
    return true;
}
