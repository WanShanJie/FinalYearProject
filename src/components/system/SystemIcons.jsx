import React from "react";

function BaseIcon({ children, className = "", strokeWidth = 1.8, viewBox = "0 0 24 24" }) {
  return (
    <svg
      className={className}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ShieldIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M12 3l7 3v6c0 4.5-2.7 8.3-7 9-4.3-.7-7-4.5-7-9V6l7-3z" />
      <path d="M9.5 12.5l1.6 1.6 3.4-3.6" />
    </BaseIcon>
  );
}

export function DashboardIcon(props) {
  return (
    <BaseIcon {...props}>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="5" rx="2" />
      <rect x="13" y="10" width="8" height="11" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
    </BaseIcon>
  );
}

export function SearchIcon(props) {
  return (
    <BaseIcon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-3.8-3.8" />
    </BaseIcon>
  );
}

export function ListIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function SettingsIcon(props) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a1.6 1.6 0 1 1-2.3 2.3l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V19a1.6 1.6 0 1 1-3.2 0v-.1a1 1 0 0 0-.6-.9 1 1 0 0 0-1.1.2l-.1.1a1.6 1.6 0 1 1-2.3-2.3l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H5a1.6 1.6 0 1 1 0-3.2h.1a1 1 0 0 0 .9-.6 1 1 0 0 0-.2-1.1l-.1-.1a1.6 1.6 0 1 1 2.3-2.3l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V5a1.6 1.6 0 1 1 3.2 0v.1a1 1 0 0 0 .6.9h.1a1 1 0 0 0 1.1-.2l.1-.1a1.6 1.6 0 1 1 2.3 2.3l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6H19a1.6 1.6 0 1 1 0 3.2h-.1a1 1 0 0 0-.9.6Z" />
    </BaseIcon>
  );
}

export function BellIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M15 18H9" />
      <path d="M18 16H6l1.2-1.3a2 2 0 0 0 .5-1.3V10a4.3 4.3 0 1 1 8.6 0v3.4a2 2 0 0 0 .5 1.3L18 16Z" />
    </BaseIcon>
  );
}

export function UserIcon(props) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </BaseIcon>
  );
}

export function LogoutIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </BaseIcon>
  );
}

export function SunIcon(props) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </BaseIcon>
  );
}

export function MoonIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M20 14.3A7.7 7.7 0 0 1 9.7 4 8.8 8.8 0 1 0 20 14.3Z" />
    </BaseIcon>
  );
}

export function FilterIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M4 5h16l-6.5 7v5l-3 2v-7L4 5Z" />
    </BaseIcon>
  );
}

export function CalendarIcon(props) {
  return (
    <BaseIcon {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </BaseIcon>
  );
}

export function SyncIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M21 12a8.8 8.8 0 0 0-15.1-6.2" />
      <path d="M3 4v5h5" />
      <path d="M3 12a8.8 8.8 0 0 0 15.1 6.2" />
      <path d="M21 20v-5h-5" />
    </BaseIcon>
  );
}

export function ImageIcon(props) {
  return (
    <BaseIcon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.2" cy="9" r="1.4" />
      <path d="M21 16l-5.5-5.5L8 18" />
    </BaseIcon>
  );
}

export function VideoIcon(props) {
  return (
    <BaseIcon {...props}>
      <rect x="3" y="5" width="12" height="14" rx="2" />
      <path d="M15 10l6-3v10l-6-3z" />
    </BaseIcon>
  );
}

export function AlertIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M12 3l9 16H3L12 3z" />
      <path d="M12 9v4" />
      <circle cx="12" cy="16.5" r=".7" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function DatabaseIcon(props) {
  return (
    <BaseIcon {...props}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
      <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </BaseIcon>
  );
}

export function CheckIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M5 12.5l4.2 4.2L19 7.5" />
    </BaseIcon>
  );
}

export function EyeIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="3" />
    </BaseIcon>
  );
}

export function LockIcon(props) {
  return (
    <BaseIcon {...props}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </BaseIcon>
  );
}


export function LinkIcon(props) {
  return (
    <BaseIcon {...props}>
      <path d="M10.5 13.5l3-3" />
      <path d="M7.2 16.8l-1.4 1.4a3.5 3.5 0 1 1-5-5l3.2-3.2a3.5 3.5 0 0 1 5 0" />
      <path d="M16.8 7.2l1.4-1.4a3.5 3.5 0 1 1 5 5L20 14a3.5 3.5 0 0 1-5 0" />
    </BaseIcon>
  );
}
