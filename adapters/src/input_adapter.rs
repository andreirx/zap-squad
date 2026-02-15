//! Input Adapter - translates platform input to core DTOs

use glam::Vec2;
use std::collections::HashSet;

/// Input event DTO for core layer
#[derive(Debug, Clone)]
pub enum InputEvent {
    KeyDown { key: String },
    KeyUp { key: String },
    PointerDown { position: Vec2, button: u8 },
    PointerUp { position: Vec2, button: u8 },
    PointerMove { position: Vec2 },
}

/// Tracks current input state
pub struct InputAdapter {
    keys_held: HashSet<String>,
    keys_just_pressed: HashSet<String>,
    keys_just_released: HashSet<String>,
    pointer_position: Vec2,
    pointer_buttons: [bool; 3],
}

impl InputAdapter {
    pub fn new() -> Self {
        Self {
            keys_held: HashSet::new(),
            keys_just_pressed: HashSet::new(),
            keys_just_released: HashSet::new(),
            pointer_position: Vec2::ZERO,
            pointer_buttons: [false; 3],
        }
    }

    /// Process an input event
    pub fn process_event(&mut self, event: InputEvent) {
        match event {
            InputEvent::KeyDown { key } => {
                if !self.keys_held.contains(&key) {
                    self.keys_just_pressed.insert(key.clone());
                }
                self.keys_held.insert(key);
            }
            InputEvent::KeyUp { key } => {
                self.keys_held.remove(&key);
                self.keys_just_released.insert(key);
            }
            InputEvent::PointerDown { position, button } => {
                self.pointer_position = position;
                if (button as usize) < 3 {
                    self.pointer_buttons[button as usize] = true;
                }
            }
            InputEvent::PointerUp { position, button } => {
                self.pointer_position = position;
                if (button as usize) < 3 {
                    self.pointer_buttons[button as usize] = false;
                }
            }
            InputEvent::PointerMove { position } => {
                self.pointer_position = position;
            }
        }
    }

    /// Clear per-frame state (call at end of frame)
    pub fn end_frame(&mut self) {
        self.keys_just_pressed.clear();
        self.keys_just_released.clear();
    }

    /// Check if a key is currently held
    pub fn key_held(&self, key: &str) -> bool {
        self.keys_held.contains(key)
    }

    /// Check if a key was just pressed this frame
    pub fn key_pressed(&self, key: &str) -> bool {
        self.keys_just_pressed.contains(key)
    }

    /// Check if a key was just released this frame
    pub fn key_released(&self, key: &str) -> bool {
        self.keys_just_released.contains(key)
    }

    /// Get current pointer position
    pub fn pointer_position(&self) -> Vec2 {
        self.pointer_position
    }

    /// Check if a pointer button is held
    pub fn pointer_button(&self, button: u8) -> bool {
        self.pointer_buttons.get(button as usize).copied().unwrap_or(false)
    }
}

impl Default for InputAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_tracking() {
        let mut input = InputAdapter::new();

        input.process_event(InputEvent::KeyDown { key: "ArrowRight".to_string() });
        assert!(input.key_held("ArrowRight"));
        assert!(input.key_pressed("ArrowRight"));

        input.end_frame();
        assert!(input.key_held("ArrowRight"));
        assert!(!input.key_pressed("ArrowRight"));

        input.process_event(InputEvent::KeyUp { key: "ArrowRight".to_string() });
        assert!(!input.key_held("ArrowRight"));
        assert!(input.key_released("ArrowRight"));
    }

    #[test]
    fn pointer_tracking() {
        let mut input = InputAdapter::new();

        input.process_event(InputEvent::PointerMove { position: Vec2::new(100.0, 200.0) });
        assert_eq!(input.pointer_position(), Vec2::new(100.0, 200.0));

        input.process_event(InputEvent::PointerDown { position: Vec2::new(100.0, 200.0), button: 0 });
        assert!(input.pointer_button(0));
    }
}
