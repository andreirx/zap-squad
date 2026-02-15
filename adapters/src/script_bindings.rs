//! Script Bindings - exposes core functionality to Rhai scripts

use rhai::{Engine, Scope, AST, Dynamic, EvalAltResult};
use glam::Vec2;
use zapsquad_core::ActorId;
use std::collections::HashMap;

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
        engine.register_type_with_name::<Vec2>("Vec2")
            .register_fn("vec2", |x: f64, y: f64| Vec2::new(x as f32, y as f32))
            .register_get("x", |v: &mut Vec2| v.x as f64)
            .register_get("y", |v: &mut Vec2| v.y as f64)
            .register_set("x", |v: &mut Vec2, x: f64| v.x = x as f32)
            .register_set("y", |v: &mut Vec2, y: f64| v.y = y as f32);

        // Register ActorId
        engine.register_type_with_name::<ActorId>("ActorId");

        Self {
            engine,
            scripts: HashMap::new(),
        }
    }

    /// Compile and register a script
    pub fn compile_script(&mut self, name: &str, source: &str) -> Result<(), Box<EvalAltResult>> {
        let ast = self.engine.compile(source)?;
        self.scripts.insert(name.to_string(), CompiledScript {
            ast,
            name: name.to_string(),
        });
        Ok(())
    }

    /// Get a compiled script by name
    pub fn get_script(&self, name: &str) -> Option<&CompiledScript> {
        self.scripts.get(name)
    }

    /// Execute on_update function for a script
    pub fn run_update(
        &self,
        script_name: &str,
        actor_id: ActorId,
        position: Vec2,
        dt: f32,
    ) -> Result<Vec2, Box<EvalAltResult>> {
        let script = self.scripts.get(script_name)
            .ok_or_else(|| Box::new(EvalAltResult::from("Script not found")))?;

        let mut scope = Scope::new();
        scope.push("entity_id", actor_id);
        scope.push("pos", position);
        scope.push("dt", dt as f64);

        // Create a simple entity proxy object
        let result = self.engine.call_fn::<Dynamic>(
            &mut scope,
            &script.ast,
            "on_update",
            (position, dt as f64),
        )?;

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
        let result = engine.compile_script("test", r#"
            fn on_update(pos, dt) {
                vec2(pos.x + 10.0 * dt, pos.y)
            }
        "#);
        assert!(result.is_ok());
    }

    #[test]
    fn run_update_script() {
        let mut engine = ScriptEngine::new();
        engine.compile_script("mover", r#"
            fn on_update(pos, dt) {
                vec2(pos.x + 100.0 * dt, pos.y)
            }
        "#).unwrap();

        let new_pos = engine.run_update(
            "mover",
            ActorId(1),
            Vec2::new(0.0, 0.0),
            1.0, // 1 second
        ).unwrap();

        assert!((new_pos.x - 100.0).abs() < 0.01);
    }
}
