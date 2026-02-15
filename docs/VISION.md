# ZapSquad Vision

## Mission
Create a **programmable 2D game engine** that enables kids to learn coding by making games.

## Core Features

### For Kids (Game Creators)
- **Visual Level Editor:** LDtk for tile-based level design
- **Simple Scripting:** Rhai scripts for game logic (movement, interactions)
- **Instant Feedback:** Hot-reload scripts, see changes immediately
- **Asset Pipeline:** Use hexmanos editors for character/object creation

### For the Engine
- **A* Pathfinding:** NPCs navigate around obstacles
- **Group Movement:** Party members follow the leader
- **Physics:** Rapier2D for collisions and dynamics
- **Rendering:** WebGPU with HDR/EDR support via zap-engine

## Architecture Principles

### Clean Architecture Layers
```
+-----------------------------------------------------+
|                    CORE (Stable)                     |
|  +-----------------------------------------------+  |
|  |              Entities                          |  |
|  |  GameState, Actor, Level, Script               |  |
|  +-----------------------------------------------+  |
|  +-----------------------------------------------+  |
|  |              Use Cases                         |  |
|  |  Pathfinding, GroupMovement, ScriptExecution   |  |
|  +-----------------------------------------------+  |
+-----------------------------------------------------+
|                 ADAPTERS (Semi-Stable)              |
|  EngineGateway, AssetGateway, InputAdapter          |
+-----------------------------------------------------+
|               INFRASTRUCTURE (Volatile)              |
|  WASM exports, React UI, Asset files                |
+-----------------------------------------------------+
```

### Dependency Rule
- Infrastructure -> Adapters -> Core
- Core NEVER imports from Adapters or Infrastructure
- Data crosses boundaries via DTOs only

## Target Audience
1. **Primary:** Kids aged 8-14 learning to code
2. **Secondary:** Educators teaching game development
3. **Tertiary:** Indie developers wanting a scriptable engine

## Success Metrics
- Kids can create a working game in under 1 hour
- Scripts are readable by someone with no coding experience
- Engine runs at 60fps on mid-range hardware
- All core logic testable without browser/WASM
