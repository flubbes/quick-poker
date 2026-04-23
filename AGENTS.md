# Quick Poker — Agent Reference

Single-container planning poker app for remote teams. Works in Firefox and Chromium-based browsers.

## Architecture
- **Backend**: Node.js + Express + Socket.IO
- **Frontend**: Vue 3 (global build, served from container)
- **Styling**: Vanilla CSS, dark mode only
- **Container**: Single Docker container

## Requirements

### Lobby / Session Lifecycle
1. Opening `/` creates a new planning session.
2. URL updates to a sharable link with a non-guessable lobby ID (URL hash).
3. Opening an existing lobby link shows current participants.
4. A lobby can be used to estimate multiple times (resettable rounds).
5. Lobby starts in "ready to estimate" state with all cards hidden.

### Estimation Flow
1. Possible estimations: `0, 1, 2, 3, 5, 8, 13, 20, 40`.
2. Until someone clicks **Reveal**, all cards stay hidden.
3. The first person to estimate can still change their mind until reveal.
4. Everyone can change their estimate freely before reveal — no one can see others' choices.
5. When **all non-PO participants have estimated**, the **Reveal** button becomes active.
6. When **Reveal** is pressed:
   - All cards are revealed.
   - No re-estimation is possible.
   - The **Reveal** button turns into a **Reset** button.
7. Clicking **Reset** starts a new estimation round (all cards hidden, estimates cleared).

### Product Owner (PO) Role
1. A user can flag themselves as PO via the settings modal.
2. POs are **not** counted toward the group that must estimate.
3. The Reveal button becomes active based only on non-PO participants.

### User Settings
1. A cogwheel icon in the top-right opens a settings modal.
2. Users can change their display name.
3. Username is persisted in `localStorage`.
4. Username is limited to 15 characters.
5. Users can toggle PO status in the same modal.

### UI / UX
1. Dark mode only.
2. Clean and simple visual design.
3. Cards show a placeholder (`?` or `✓`) while hidden, actual value when revealed.
4. Own card is visually distinguished.
5. PO participants are visually distinguished (e.g., border color).

### Browser Compatibility
- Firefox (latest)
- Chromium-based browsers (Chrome, Edge, Brave, etc.)
