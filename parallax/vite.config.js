import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        host: '0.0.0.0',
        port: 5173,
        allowedHosts: [
            'northwest-downloaded-paperback-implement.trycloudflare.com',
            'ancient-pubs-lions-volunteers.trycloudflare.com',
            'bristol-tribal-culture-airport.trycloudflare.com'
        ],
        proxy: {
            '/api': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                secure: true
            },
            '/uploads': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                secure: true
            },
            '/socket.io': {
                target: 'http://localhost:3001',
                changeOrigin: true,
                secure: true,
                ws: true
            }
        }
    },
    preview: {
        host: '0.0.0.0',
        port: 4173
    }
});
