/* global React */
/* NovaMail icon set — lucide-style, stroke 1.6, currentColor (lifted + extended from Kryton's I.*) */

const Icon = ({ d, size = 14, stroke = 1.6, fill = 'none', children, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
       strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }}>
    {d ? <path d={d} /> : children}
  </svg>
);

const I = {
  Search:   (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></Icon>,
  Plus:     (p) => <Icon {...p} d="M12 5v14M5 12h14"/>,
  Chevron:  (p) => <Icon {...p} d="m9 6 6 6-6 6"/>,
  ChevronD: (p) => <Icon {...p} d="m6 9 6 6 6-6"/>,
  ChevronR: (p) => <Icon {...p} d="m9 6 6 6-6 6"/>,
  ArrowRight:(p)=> <Icon {...p} d="M5 12h14M13 6l6 6-6 6"/>,
  ArrowUp:  (p) => <Icon {...p} d="M12 19V5M5 12l7-7 7 7"/>,
  ArrowDown:(p) => <Icon {...p} d="M12 5v14M5 12l7 7 7-7"/>,
  ArrowUpRight:(p)=> <Icon {...p} d="M7 17 17 7M8 7h9v9"/>,

  /* mail / relay domain */
  Mail:     (p) => <Icon {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6 8.5-6"/></Icon>,
  MailOpen: (p) => <Icon {...p}><path d="M3 9.5 12 4l9 5.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m3 9.5 9 6 9-6"/></Icon>,
  Send:     (p) => <Icon {...p} d="M22 2 11 13M22 2 15 22l-4-9-9-4z"/>,
  Inbox:    (p) => <Icon {...p}><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5 4h14l3 8v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></Icon>,
  Server:   (p) => <Icon {...p}><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></Icon>,
  Route:    (p) => <Icon {...p}><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H14a3.5 3.5 0 0 0 0-7H10a3.5 3.5 0 0 1 0-7h5.5"/></Icon>,
  Globe:    (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/></Icon>,
  Gauge:    (p) => <Icon {...p}><path d="M12 14 16 9"/><path d="M3.5 16a9 9 0 1 1 17 0"/><circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none"/></Icon>,
  Key:      (p) => <Icon {...p}><circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 9-9M16 4l3 3M14 6l2.5 2.5"/></Icon>,
  Users:    (p) => <Icon {...p}><circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0M16 5.2a3.2 3.2 0 0 1 0 6.1M21 20a6 6 0 0 0-4-5.6"/></Icon>,
  Shield:   (p) => <Icon {...p}><path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/></Icon>,
  Ban:      (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></Icon>,
  List:     (p) => <Icon {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></Icon>,
  Layers:   (p) => <Icon {...p}><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5M3 17l9 5 9-5"/></Icon>,
  Activity: (p) => <Icon {...p} d="M3 12h4l3 8 4-16 3 8h4"/>,
  Clock:    (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>,
  Pause:    (p) => <Icon {...p}><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></Icon>,
  Play:     (p) => <Icon {...p} fill="currentColor" stroke="none" d="M7 5.5v13l11-6.5z"/>,
  Refresh:  (p) => <Icon {...p} d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>,
  Filter:   (p) => <Icon {...p} d="M3 4h18l-7 9v6l-4 2v-8z"/>,
  AlertTriangle:(p)=> <Icon {...p}><path d="M10.3 3.8 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></Icon>,
  CheckCircle:(p)=> <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></Icon>,
  Check:    (p) => <Icon {...p} d="m5 13 4 4L19 7"/>,
  X:        (p) => <Icon {...p} d="M18 6 6 18M6 6l12 12"/>,
  Trash:    (p) => <Icon {...p}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6M10 11v6M14 11v6"/></Icon>,
  Edit:     (p) => <Icon {...p} d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>,
  Settings: (p) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></Icon>,
  PanelLeft:(p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></Icon>,
  Layout:   (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></Icon>,
  Sun:      (p) => <Icon {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M5 5l1.5 1.5M17.5 17.5 19 19M2 12h2M20 12h2M5 19l1.5-1.5M17.5 6.5 19 5"/></Icon>,
  Moon:     (p) => <Icon {...p} d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>,
  Sparkle:  (p) => <Icon {...p} d="M12 3v6M12 15v6M3 12h6M15 12h6M5.5 5.5 9 9M15 15l3.5 3.5M5.5 18.5 9 15M15 9l3.5-3.5"/>,
  Zap:      (p) => <Icon {...p} d="M13 2 3 14h7l-1 8 10-12h-7z"/>,
  Command:  (p) => <Icon {...p} d="M18 3a3 3 0 0 0 0 6h-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3v3H6a3 3 0 1 0 3 3V9h6v3a3 3 0 1 0 3-3"/>,
  Dot:      (p) => <Icon {...p}><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></Icon>,
  Copy:     (p) => <Icon {...p}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></Icon>,
  More:     (p) => <Icon {...p}><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/></Icon>,
  Hash:     (p) => <Icon {...p} d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>,
  Lock:     (p) => <Icon {...p}><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></Icon>,
  ExternalLink:(p)=> <Icon {...p} d="M14 4h6v6M20 4 11 13M18 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>,

  /* NovaMail logomark — rounded-square node frame + envelope + relay node */
  Logo: ({ size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <defs>
        <linearGradient id="nm-grad" x1="0" y1="0" x2="24" y2="24">
          <stop offset="0" stopColor="var(--accent)"/>
          <stop offset="1" stopColor="var(--accent-2)"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="5.5" fill="url(#nm-grad)" opacity="0.16"/>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" stroke="url(#nm-grad)" strokeWidth="1"/>
      <rect x="6" y="8" width="12" height="9" rx="1.6" stroke="url(#nm-grad)" strokeWidth="1.4"/>
      <path d="M6.4 8.8 12 12.6 17.6 8.8" stroke="url(#nm-grad)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
      <circle cx="18" cy="7" r="2.4" fill="var(--accent)" stroke="var(--bg-1)" strokeWidth="1.1"/>
    </svg>
  ),
};

window.Icon = Icon;
window.I = I;
