//! Group movement use case - follow the leader
//!
//! Implements smooth following behavior using position history.

use glam::Vec2;
use std::collections::VecDeque;

/// Maximum history entries to keep (seconds * fps)
const MAX_HISTORY: usize = 300; // 5 seconds at 60fps

/// State for a follower entity
#[derive(Debug, Clone)]
pub struct FollowState {
    /// Positions recorded over time: (timestamp, position)
    history: VecDeque<(f32, Vec2)>,
    /// How many seconds behind the leader to follow
    pub delay: f32,
    /// Minimum distance to maintain from target position
    pub min_distance: f32,
    /// Movement speed
    pub speed: f32,
}

impl Default for FollowState {
    fn default() -> Self {
        Self {
            history: VecDeque::with_capacity(MAX_HISTORY),
            delay: 0.5,
            min_distance: 20.0,
            speed: 100.0,
        }
    }
}

impl FollowState {
    pub fn new(delay: f32, speed: f32) -> Self {
        Self {
            delay,
            speed,
            ..Default::default()
        }
    }

    /// Record a position in history (call for leader)
    pub fn record_position(&mut self, time: f32, position: Vec2) {
        self.history.push_back((time, position));

        // Trim old entries
        while self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }
    }

    /// Get position from history at a given time
    pub fn position_at(&self, time: f32) -> Option<Vec2> {
        if self.history.is_empty() {
            return None;
        }

        // Find the two entries that bracket the requested time
        let mut prev: Option<(f32, Vec2)> = None;

        for &(t, pos) in &self.history {
            if t >= time {
                if let Some((pt, ppos)) = prev {
                    // Interpolate between prev and current
                    let alpha = (time - pt) / (t - pt);
                    return Some(ppos.lerp(pos, alpha));
                } else {
                    // Time is before first entry
                    return Some(pos);
                }
            }
            prev = Some((t, pos));
        }

        // Time is after last entry - return last position
        self.history.back().map(|&(_, pos)| pos)
    }

    /// Clear history
    pub fn clear(&mut self) {
        self.history.clear();
    }
}

/// Update follower positions based on leader history
///
/// Returns the target position the follower should move toward.
pub fn update_followers(
    leader_history: &FollowState,
    current_time: f32,
    follower_delay: f32,
) -> Option<Vec2> {
    let target_time = current_time - follower_delay;
    leader_history.position_at(target_time)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_retrieve() {
        let mut state = FollowState::default();

        state.record_position(0.0, Vec2::new(0.0, 0.0));
        state.record_position(1.0, Vec2::new(100.0, 0.0));

        // Exact time
        let pos = state.position_at(0.0).unwrap();
        assert_eq!(pos, Vec2::new(0.0, 0.0));

        let pos = state.position_at(1.0).unwrap();
        assert_eq!(pos, Vec2::new(100.0, 0.0));
    }

    #[test]
    fn interpolation() {
        let mut state = FollowState::default();

        state.record_position(0.0, Vec2::new(0.0, 0.0));
        state.record_position(1.0, Vec2::new(100.0, 0.0));

        // Midpoint interpolation
        let pos = state.position_at(0.5).unwrap();
        assert!((pos.x - 50.0).abs() < 0.01);
    }

    #[test]
    fn update_followers_with_delay() {
        let mut leader = FollowState::default();

        // Leader moves right over time
        leader.record_position(0.0, Vec2::new(0.0, 0.0));
        leader.record_position(0.5, Vec2::new(50.0, 0.0));
        leader.record_position(1.0, Vec2::new(100.0, 0.0));

        // Follower with 0.5s delay at time 1.0 should be at leader's 0.5s position
        let target = update_followers(&leader, 1.0, 0.5).unwrap();
        assert!((target.x - 50.0).abs() < 0.01);
    }
}
