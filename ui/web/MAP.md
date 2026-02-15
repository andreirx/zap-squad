# Web Application (`ui/web/`)

## Role: UI & Delivery
This is the frontend application. It is a "Detail" in Clean Architecture terms. The game logic should not depend on whether it is rendered in React, Vue, or a native window.

## Technology Stack
- **Framework:** React
- **Build Tool:** Vite
- **Language:** TypeScript

## Responsibilities
- **Rendering:** Displaying the game state to the user.
- **Input:** Capturing user input and sending it to the `Wasm` bridge (which forwards to `adapters`).
- **Assets:** Serving static assets.

## Boundary
- **Input:** User events -> `Wasm` Bridge.
- **Output:** Game State updates <- `Wasm` Bridge.
