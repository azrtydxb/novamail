// Bootstrap: the ported prototype modules cross-reference each other via window
// globals (window.React, window.I, window.NM_DATA, window.Store, screen comps).
// _globals (imported FIRST so its side effect runs before the proto modules
// evaluate) puts React on window; then modules attach their symbols; mount App.
import "./proto/_globals.ts";
import "./styles/tokens.css";

import "./proto/icons.jsx";
import "./proto/ui.jsx";
import "./proto/store.jsx";
import "./proto/modals.jsx";
import "./proto/sidebar.jsx";
import "./proto/tables.jsx";
import "./proto/screens2.jsx";
import "./proto/dashboard.jsx";
import "./proto/messages.jsx";
import "./proto/providers.jsx";
import "./proto/deliverability.jsx";
import "./proto/notifications.jsx";
import "./proto/queue.jsx";
import "./proto/settings.jsx";
import "./proto/login.jsx";
import "./proto/palette.jsx";
import "./proto/main.jsx";

import { createRoot } from "react-dom/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const App = (window as any).App;
createRoot(document.getElementById("root")!).render(<App />);
