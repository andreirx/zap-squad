/// Base URL for baked assets. Set via VITE_ASSETS_URL in .env.
/// Local dev: "/assets" (served by Vite middleware from ui/web/public/assets/).
/// Production: "https://{cloudfront-id}.cloudfront.net/assets".
export const ASSETS_URL = import.meta.env.VITE_ASSETS_URL || '/assets';
