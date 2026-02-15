# UI Layer (`ui/`)

## Role: Presentation
This layer contains all user-facing code. It is responsible for presenting data to the user and interpreting user commands. By elevating this from "Infrastructure", we acknowledge that the Editors and Game Client are significant parts of the application logic ("Presentation Logic").

## Sub-layers

### [Web Application](./web/MAP.md)
- **Concept:** The main entry point for the user.
- **Tech Stack:** React, Vite, TypeScript.
- **Location:** `ui/web/`

## Editors
The editors (Tile Editor, Character Editor, etc.) are located within the web application but represent a distinct functional area:
- **Location:** `ui/web/src/editors/`
- **Responsibilities:**
    - Level Design
    - Asset Management
    - Character Customization

## Dependencies
- **Depends on:** `infrastructure/wasm` (to communicate with the Core).
- **Depends on:** `adapters` (types and interfaces, if shared).
