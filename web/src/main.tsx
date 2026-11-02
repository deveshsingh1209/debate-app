import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import App from './App';
import { AttentionWatcher } from './components/AttentionWatcher';
import { armAudio } from './lib/voice';
import { applyTheme, watchSystemTheme } from './design/theme';
// index.css is the v1 layout sheet and theme.css the naval sheet; the design
// system loads last so its tokens and rules win every cascade tie.
import './index.css';
import './theme.css';
import './design/tokens.css';
import './design/system.css';
import './design/room.css';

// The theme is on <html> before the first render, so nothing flashes.
applyTheme();
watchSystemTheme();

// No StrictMode: its dev-only double-invocation wedges framer-motion 12's
// presence/exit bookkeeping under React 19 (stuck gate transitions, docks
// animating from off-screen and never arriving). Prod builds never run
// StrictMode behaviors, so this also keeps dev behavior aligned with prod.
// Sound is off until the founder turns it on; a founder who turned it on last
// time gets it back on their first click or key press.
armAudio();

createRoot(document.getElementById('root')!).render(
  // reducedMotion="user": every framer-motion transform is dropped when the
  // system asks for reduced motion; opacity and colour still change.
  <MotionConfig reducedMotion="user">
    <BrowserRouter>
      <AttentionWatcher />
      <App />
    </BrowserRouter>
  </MotionConfig>,
);
