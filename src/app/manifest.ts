import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'AgendaMagna',
    short_name: 'AgendaMagna',
    description: 'Suas tarefas e seu assistente, no notebook e no celular.',
    lang: 'pt-BR',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f5f5f6',
    theme_color: '#63039a',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
