import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveParallaxMediaUrl } from './media-url.js';

test('routes local backend media through the current app origin', () => {
    assert.equal(
        resolveParallaxMediaUrl(
            'https://10.125.9.206:3001/uploads/panorama.jpg',
            'http://192.168.56.1:5173/controller'
        ),
        '/uploads/panorama.jpg'
    );
    assert.equal(
        resolveParallaxMediaUrl(
            'http://localhost:3001/uploads/panorama.mp4?download=1',
            'https://parallax.example/controller'
        ),
        '/uploads/panorama.mp4?download=1'
    );
});

test('preserves public media URLs and unrelated paths', () => {
    assert.equal(
        resolveParallaxMediaUrl(
            'https://cdn.example.com/uploads/panorama.jpg',
            'https://parallax.example/controller'
        ),
        'https://cdn.example.com/uploads/panorama.jpg'
    );
    assert.equal(
        resolveParallaxMediaUrl(
            'https://10.125.9.206:3001/api/status',
            'http://192.168.56.1:5173/controller'
        ),
        'https://10.125.9.206:3001/api/status'
    );
});
