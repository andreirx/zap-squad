//! Script Bindings - exposes core functionality to Rhai scripts
//!
//! Scripts emit commands that are executed by the game loop.
//! This decouples script execution from state mutation.

use glam::Vec2;
use rhai::{Dynamic, Engine, EvalAltResult, Scope, AST};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use zapsquad_core::{ActorId, AnimationState, Direction};

/// Commands that scripts can emit
#[derive(Debug, Clone)]
pub enum ScriptCommand {
    /// Move to a target position
    MoveTo(Vec2),
    /// Attack a target actor
    Attack(ActorId),
    /// Set facing direction
    SetDirection(Direction),
    /// Set animation state
    SetAnimation(AnimationState),
    /// Play a sound effect
    PlaySound(String),
    /// Set movement velocity
    SetVelocity(Vec2),
}

/// World query interface for scripts to read game state
#[derive(Debug, Clone, Default)]
pub struct WorldQuery {
    /// All actors with their positions and tags
    pub actors: Vec<(ActorId, Vec2, String)>,
}

impl WorldQuery {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an actor to the query
    pub fn add_actor(&mut self, id: ActorId, position: Vec2, tag: String) {
        self.actors.push((id, position, tag));
    }

    /// Find the nearest actor with a given tag
    pub fn find_nearest(&self, from: Vec2, tag: &str, exclude_id: ActorId) -> Option<ActorId> {
        self.actors
            .iter()
            .filter(|(id, _, t)| t == tag && *id != exclude_id)
            .min_by(|(_, pos_a, _), (_, pos_b, _)| {
                let dist_a = from.distance_squared(*pos_a);
                let dist_b = from.distance_squared(*pos_b);
                dist_a.partial_cmp(&dist_b).unwrap()
            })
            .map(|(id, _, _)| *id)
    }

    /// Get position of an actor by ID
    pub fn get_position(&self, id: ActorId) -> Option<Vec2> {
        self.actors
            .iter()
            .find(|(actor_id, _, _)| *actor_id == id)
            .map(|(_, pos, _)| *pos)
    }
}

/// Context passed to scripts during execution
#[derive(Clone)]
pub struct ScriptContext {
    pub self_id: ActorId,
    pub self_pos: Vec2,
    pub dt: f32,
    commands: Arc<Mutex<Vec<ScriptCommand>>>,
    query: WorldQuery,
}

impl ScriptContext {
    pub fn new(self_id: ActorId, self_pos: Vec2, dt: f32, query: WorldQuery) -> Self {
        Self {
            self_id,
            self_pos,
            dt,
            commands: Arc::new(Mutex::new(Vec::new())),
            query,
        }
    }

    /// Get accumulated commands
    pub fn take_commands(&self) -> Vec<ScriptCommand> {
        self.commands.lock().unwrap().drain(..).collect()
    }

    // --- Command API (called from scripts) ---

    fn cmd_move_to(&self, x: f64, y: f64) {
        self.commands
            .lock()
            .unwrap()
            .push(ScriptCommand::MoveTo(Vec2::new(x as f32, y as f32)));
    }

    fn cmd_attack(&self, target_id: i64) {
        self.commands
            .lock()
            .unwrap()
            .push(ScriptCommand::Attack(ActorId(target_id as u32)));
    }

    fn cmd_face(&self, direction: &str) {
        let dir = match direction.to_lowercase().as_str() {
            "north" | "up" => Direction::North,
            "south" | "down" => Direction::South,
            "east" | "right" => Direction::East,
            "west" | "left" => Direction::West,
            _ => return,
        };
        self.commands
            .lock()
            .unwrap()
            .push(ScriptCommand::SetDirection(dir));
    }

    fn cmd_set_animation(&self, state: &str) {
        let anim = match state.to_lowercase().as_str() {
            "idle" => AnimationState::Idle,
            "walk" => AnimationState::Walk,
            "melee" | "melee_attack" => AnimationState::MeleeAttack,
            "throw" | "throw_attack" => AnimationState::ThrowAttack,
            _ => return,
        };
        self.commands
            .lock()
            .unwrap()
            .push(ScriptCommand::SetAnimation(anim));
    }

    fn cmd_set_velocity(&self, x: f64, y: f64) {
        self.commands
            .lock()
            .unwrap()
            .push(ScriptCommand::SetVelocity(Vec2::new(x as f32, y as f32)));
    }

    fn cmd_play_sound(&self, name: String) {
        self.commands
            .lock()
            .unwrap()
            .push(ScriptCommand::PlaySound(name));
    }

    // --- Query API (read-only) ---

    fn query_find_nearest(&self, tag: &str) -> i64 {
        self.query
            .find_nearest(self.self_pos, tag, self.self_id)
            .map(|id| id.0 as i64)
            .unwrap_or(-1)
    }

    fn query_get_position(&self, actor_id: i64) -> Dynamic {
        if let Some(pos) = self.query.get_position(ActorId(actor_id as u32)) {
            Dynamic::from(pos)
        } else {
            Dynamic::UNIT
        }
    }

    fn query_self_pos(&self) -> Vec2 {
        self.self_pos
    }

    fn query_self_id(&self) -> i64 {
        self.self_id.0 as i64
    }

    fn query_dt(&self) -> f64 {
        self.dt as f64
    }
}

/// Compiled script ready for execution
pub struct CompiledScript {
    pub ast: AST,
    pub name: String,
}

/// Script execution engine
pub struct ScriptEngine {
    engine: Engine,
    scripts: HashMap<String, CompiledScript>,
}

impl ScriptEngine {
    pub fn new() -> Self {
        let mut engine = Engine::new();

        // Register Vec2 type for scripts
        engine
            .register_type_with_name::<Vec2>("Vec2")
            .register_fn("vec2", |x: f64, y: f64| Vec2::new(x as f32, y as f32))
            .register_get("x", |v: &mut Vec2| v.x as f64)
            .register_get("y", |v: &mut Vec2| v.y as f64)
            .register_set("x", |v: &mut Vec2, x: f64| v.x = x as f32)
            .register_set("y", |v: &mut Vec2, y: f64| v.y = y as f32);

        // Register ActorId
        engine.register_type_with_name::<ActorId>("ActorId");

        // Register ScriptContext type
        engine.register_type_with_name::<ScriptContext>("Context");

        // --- Register Command Functions ---

        // move_to(ctx, x, y) - Move to target position
        engine.register_fn("move_to", |ctx: &mut ScriptContext, x: f64, y: f64| {
            ctx.cmd_move_to(x, y);
        });

        // attack(ctx, target_id) - Attack a target
        engine.register_fn("attack", |ctx: &mut ScriptContext, target_id: i64| {
            ctx.cmd_attack(target_id);
        });

        // face(ctx, direction) - Set facing direction
        engine.register_fn("face", |ctx: &mut ScriptContext, direction: &str| {
            ctx.cmd_face(direction);
        });

        // set_animation(ctx, state) - Set animation state
        engine.register_fn("set_animation", |ctx: &mut ScriptContext, state: &str| {
            ctx.cmd_set_animation(state);
        });

        // set_velocity(ctx, x, y) - Set movement velocity
        engine.register_fn(
            "set_velocity",
            |ctx: &mut ScriptContext, x: f64, y: f64| {
                ctx.cmd_set_velocity(x, y);
            },
        );

        // play_sound(ctx, name) - Play a sound effect
        engine.register_fn("play_sound", |ctx: &mut ScriptContext, name: &str| {
            ctx.cmd_play_sound(name.to_string());
        });

        // --- Register Query Functions ---

        // find_nearest(ctx, tag) - Find nearest actor with tag, returns id or -1
        engine.register_fn("find_nearest", |ctx: &mut ScriptContext, tag: &str| -> i64 {
            ctx.query_find_nearest(tag)
        });

        // get_position(ctx, actor_id) - Get position of an actor
        engine.register_fn(
            "get_position",
            |ctx: &mut ScriptContext, actor_id: i64| -> Dynamic { ctx.query_get_position(actor_id) },
        );

        // self_pos(ctx) - Get own position
        engine.register_fn("self_pos", |ctx: &mut ScriptContext| -> Vec2 {
            ctx.query_self_pos()
        });

        // self_id(ctx) - Get own actor ID
        engine.register_fn("self_id", |ctx: &mut ScriptContext| -> i64 {
            ctx.query_self_id()
        });

        // dt(ctx) - Get delta time
        engine.register_fn("dt", |ctx: &mut ScriptContext| -> f64 { ctx.query_dt() });

        // --- Register Utility Functions ---

        // dist(x1, y1, x2, y2) - Calculate distance between two points
        engine.register_fn("dist", |x1: f64, y1: f64, x2: f64, y2: f64| -> f64 {
            let dx = x2 - x1;
            let dy = y2 - y1;
            (dx * dx + dy * dy).sqrt()
        });

        // dist_vec(a, b) - Calculate distance between two Vec2
        engine.register_fn("dist_vec", |a: Vec2, b: Vec2| -> f64 { a.distance(b) as f64 });

        // normalize(x, y) - Normalize a vector
        engine.register_fn("normalize", |x: f64, y: f64| -> Vec2 {
            let v = Vec2::new(x as f32, y as f32);
            if v.length_squared() > 0.0001 {
                v.normalize()
            } else {
                Vec2::ZERO
            }
        });

        // lerp(a, b, t) - Linear interpolation
        engine.register_fn("lerp", |a: f64, b: f64, t: f64| -> f64 { a + (b - a) * t.clamp(0.0, 1.0) });

        Self {
            engine,
            scripts: HashMap::new(),
        }
    }

    /// Compile and register a script
    pub fn compile_script(&mut self, name: &str, source: &str) -> Result<(), Box<EvalAltResult>> {
        let ast = self.engine.compile(source)?;
        self.scripts.insert(
            name.to_string(),
            CompiledScript {
                ast,
                name: name.to_string(),
            },
        );
        Ok(())
    }

    /// Remove a script
    pub fn remove_script(&mut self, name: &str) -> bool {
        self.scripts.remove(name).is_some()
    }

    /// Clear all scripts
    pub fn clear_scripts(&mut self) {
        self.scripts.clear();
    }

    /// Get a compiled script by name
    pub fn get_script(&self, name: &str) -> Option<&CompiledScript> {
        self.scripts.get(name)
    }

    /// List all script names
    pub fn list_scripts(&self) -> Vec<&str> {
        self.scripts.keys().map(|s| s.as_str()).collect()
    }

    /// Execute on_update function for a script with context
    /// Returns the commands emitted by the script
    pub fn run_update_with_context(
        &self,
        script_name: &str,
        context: ScriptContext,
    ) -> Result<Vec<ScriptCommand>, Box<EvalAltResult>> {
        let script = self
            .scripts
            .get(script_name)
            .ok_or_else(|| Box::new(EvalAltResult::from("Script not found")))?;

        let mut scope = Scope::new();

        // Call the update function with context
        let _: () = self
            .engine
            .call_fn(&mut scope, &script.ast, "update", (context.clone(),))
            .unwrap_or(());

        Ok(context.take_commands())
    }

    /// Legacy: Execute on_update function returning new position
    /// Kept for backwards compatibility
    pub fn run_update(
        &self,
        script_name: &str,
        actor_id: ActorId,
        position: Vec2,
        dt: f32,
    ) -> Result<Vec2, Box<EvalAltResult>> {
        let script = self
            .scripts
            .get(script_name)
            .ok_or_else(|| Box::new(EvalAltResult::from("Script not found")))?;

        let mut scope = Scope::new();
        scope.push("entity_id", actor_id);
        scope.push("pos", position);
        scope.push("dt", dt as f64);

        // Create a simple entity proxy object
        let result = self
            .engine
            .call_fn::<Dynamic>(&mut scope, &script.ast, "on_update", (position, dt as f64))?;

        // Try to extract new position
        if let Some(new_pos) = result.try_cast::<Vec2>() {
            Ok(new_pos)
        } else {
            Ok(position)
        }
    }
}

impl Default for ScriptEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_simple_script() {
        let mut engine = ScriptEngine::new();
        let result = engine.compile_script(
            "test",
            r#"
            fn on_update(pos, dt) {
                vec2(pos.x + 10.0 * dt, pos.y)
            }
        "#,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn run_update_script() {
        let mut engine = ScriptEngine::new();
        engine
            .compile_script(
                "mover",
                r#"
            fn on_update(pos, dt) {
                vec2(pos.x + 100.0 * dt, pos.y)
            }
        "#,
            )
            .unwrap();

        let new_pos = engine
            .run_update("mover", ActorId(1), Vec2::new(0.0, 0.0), 1.0)
            .unwrap();

        assert!((new_pos.x - 100.0).abs() < 0.01);
    }

    #[test]
    fn run_update_with_commands() {
        let mut engine = ScriptEngine::new();
        engine
            .compile_script(
                "attacker",
                r#"
            fn update(ctx) {
                let target = find_nearest(ctx, "enemy");
                if target >= 0 {
                    attack(ctx, target);
                    face(ctx, "north");
                }
            }
        "#,
            )
            .unwrap();

        let mut query = WorldQuery::new();
        query.add_actor(ActorId(1), Vec2::new(0.0, 0.0), "player".to_string());
        query.add_actor(ActorId(2), Vec2::new(10.0, 10.0), "enemy".to_string());

        let ctx = ScriptContext::new(ActorId(1), Vec2::new(0.0, 0.0), 0.016, query);

        let commands = engine.run_update_with_context("attacker", ctx).unwrap();

        assert_eq!(commands.len(), 2);
        assert!(matches!(commands[0], ScriptCommand::Attack(ActorId(2))));
        assert!(matches!(
            commands[1],
            ScriptCommand::SetDirection(Direction::North)
        ));
    }

    #[test]
    fn move_to_command() {
        let mut engine = ScriptEngine::new();
        engine
            .compile_script(
                "mover",
                r#"
            fn update(ctx) {
                move_to(ctx, 100.0, 200.0);
            }
        "#,
            )
            .unwrap();

        let ctx = ScriptContext::new(ActorId(1), Vec2::ZERO, 0.016, WorldQuery::new());
        let commands = engine.run_update_with_context("mover", ctx).unwrap();

        assert_eq!(commands.len(), 1);
        if let ScriptCommand::MoveTo(pos) = &commands[0] {
            assert_eq!(*pos, Vec2::new(100.0, 200.0));
        } else {
            panic!("Expected MoveTo command");
        }
    }

    #[test]
    fn dist_function() {
        let mut engine = ScriptEngine::new();
        engine
            .compile_script(
                "distance_check",
                r#"
            fn update(ctx) {
                let d = dist(0.0, 0.0, 3.0, 4.0);
                if d < 6.0 {
                    move_to(ctx, d, 0.0);
                }
            }
        "#,
            )
            .unwrap();

        let ctx = ScriptContext::new(ActorId(1), Vec2::ZERO, 0.016, WorldQuery::new());
        let commands = engine.run_update_with_context("distance_check", ctx).unwrap();

        assert_eq!(commands.len(), 1);
        if let ScriptCommand::MoveTo(pos) = &commands[0] {
            assert!((pos.x - 5.0).abs() < 0.01); // 3-4-5 triangle
        } else {
            panic!("Expected MoveTo command");
        }
    }

    #[test]
    fn find_nearest_no_match() {
        let mut engine = ScriptEngine::new();
        engine
            .compile_script(
                "finder",
                r#"
            fn update(ctx) {
                let target = find_nearest(ctx, "nonexistent");
                if target < 0 {
                    face(ctx, "south");
                }
            }
        "#,
            )
            .unwrap();

        let ctx = ScriptContext::new(ActorId(1), Vec2::ZERO, 0.016, WorldQuery::new());
        let commands = engine.run_update_with_context("finder", ctx).unwrap();

        assert_eq!(commands.len(), 1);
        assert!(matches!(
            commands[0],
            ScriptCommand::SetDirection(Direction::South)
        ));
    }

    #[test]
    fn list_and_remove_scripts() {
        let mut engine = ScriptEngine::new();
        engine
            .compile_script("a", "fn update(ctx) {}")
            .unwrap();
        engine
            .compile_script("b", "fn update(ctx) {}")
            .unwrap();

        let mut names: Vec<&str> = engine.list_scripts();
        names.sort();
        assert_eq!(names, vec!["a", "b"]);

        assert!(engine.remove_script("a"));
        assert!(!engine.remove_script("nonexistent"));

        let names: Vec<&str> = engine.list_scripts();
        assert_eq!(names, vec!["b"]);
    }
}
