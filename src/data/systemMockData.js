export const headerNav = [
  { label: "Dashboard", to: "/dashboard", key: "dashboard" },
  { label: "Media Analysis", to: "/media-analysis", key: "media" },
  { label: "Blocklist Manager", to: "/blocklist-manager", key: "blocklist" },
  { label: "Monitoring", to: "/admin/monitoring", key: "monitoring" },
  { label: "Settings", to: "/settings", key: "settings" },
];

export const quickStats = [
  { label: "Today's Scans", value: "247" },
  { label: "Threats Blocked", value: "12" },
];

export const dashboardKpis = [
  { title: "Total Media Analyzed", value: "1,240", tone: "blue" },
  { title: "Deepfakes Detected", value: "85", tone: "red" },
  { title: "Auto-Blocked", value: "12", tone: "amber" },
  { title: "Active Fingerprints", value: "3,500", sub: "Global DB", tone: "cyan" },
];

export const liveFeed = [
  { id: 1, type: "image", state: "clean", source: "X" },
  { id: 2, type: "video", state: "analyzing", source: "Facebook" },
  { id: 3, type: "image", state: "clean", source: "Instagram" },
  { id: 4, type: "video", state: "threat", source: "TikTok" },
  { id: 5, type: "video", state: "clean", source: "YouTube" },
];

export const trendBars = [34, 42, 39, 58, 76, 72, 88, 94, 64, 52, 48, 61];

export const activityTimeline = [
  { time: "10:42 AM", text: "Blocked User X on X.com", tag: "Blocked", tone: "red" },
  { time: "10:38 AM", text: "Verified video from CNN official", tag: "Verified", tone: "green" },
  { time: "10:35 AM", text: "Suspicious content flagged on Facebook", tag: "Flagged", tone: "amber" },
  { time: "10:30 AM", text: "Completed scan of instagram_video.mp4", tag: "Complete", tone: "blue" },
  { time: "10:25 AM", text: "Added 3 new fingerprints to Global DB", tag: "Synced", tone: "cyan" },
];

export const mediaDetections = [
  {
    id: "scan-1041",
    title: "political_speech_final.mp4",
    type: "video",
    source: "YouTube",
    url: "youtube.com/watch?v=analysis1041",
    verdict: "fake",
    confidence: 98,
    timestamp: "2026-03-14 09:22",
    size: "24.6 MB",
    duration: "00:43",
    resolution: "1920 × 1080",
    codec: "H.264",
    frameRate: "30 fps",
    speaker: "Public Figure A",
    summary:
      "The media is classified as likely deepfake because several face regions show inconsistent mouth synthesis, unstable edge blending around the jawline, and frame-to-frame lighting mismatch during head movement.",
    reasoning: [
      "Mouth movement and phoneme alignment drift in frames 102–118.",
      "Skin texture changes abruptly around cheeks and lower face during rotation.",
      "Eye reflections remain static while surrounding facial lighting shifts.",
    ],
    policy: "Recommend block and analyst review before distribution.",
    evidence: [
      { id: "F-104", label: "Frame 104", score: 0.98, note: "Mouth contour warping during speech." },
      { id: "F-111", label: "Frame 111", score: 0.97, note: "Blending seam visible on left jaw." },
      { id: "F-118", label: "Frame 118", score: 0.95, note: "Lighting mismatch near eye region." },
    ],
  },
  {
    id: "scan-1039",
    title: "profile_statement.jpg",
    type: "image",
    source: "Facebook",
    url: "facebook.com/photo/1039",
    verdict: "real",
    confidence: 92,
    timestamp: "2026-03-14 08:54",
    size: "3.2 MB",
    duration: "—",
    resolution: "2048 × 1365",
    codec: "JPEG",
    frameRate: "—",
    speaker: "N/A",
    summary:
      "The image is considered authentic because facial edges remain consistent, compression artifacts are uniform, and no anomalous synthesis patterns were detected across the image regions.",
    reasoning: [
      "Compression noise is evenly distributed across the entire image.",
      "No local texture duplication detected around hairline or eyes.",
      "Metadata and pixel structure align with typical camera output.",
    ],
    policy: "Allow content. No further action required.",
    evidence: [
      { id: "ROI-1", label: "Eye region", score: 0.12, note: "No synthesis residue found." },
      { id: "ROI-2", label: "Hairline", score: 0.10, note: "Natural edge transition." },
      { id: "ROI-3", label: "Background texture", score: 0.08, note: "Consistent compression pattern." },
    ],
  },
  {
    id: "scan-1036",
    title: "concert_clip_edit.mp4",
    type: "video",
    source: "TikTok",
    url: "tiktok.com/@artist/video/1036",
    verdict: "inconclusive",
    confidence: 74,
    timestamp: "2026-03-14 07:18",
    size: "11.8 MB",
    duration: "00:19",
    resolution: "1080 × 1920",
    codec: "H.265",
    frameRate: "60 fps",
    speaker: "Performer",
    summary:
      "The clip remains inconclusive because motion blur and strong compression obscure decisive forensic signals. Some facial regions appear unstable, but evidence is not strong enough for automatic blocking.",
    reasoning: [
      "High compression causes loss of fine-grain facial texture.",
      "Fast motion introduces blur that reduces model certainty.",
      "Several frames show suspicious artifacts, but not persistently.",
    ],
    policy: "Send to analyst review queue. Do not auto-block yet.",
    evidence: [
      { id: "F-051", label: "Frame 51", score: 0.76, note: "Possible warping under motion blur." },
      { id: "F-063", label: "Frame 63", score: 0.71, note: "Edge halo around chin." },
      { id: "F-075", label: "Frame 75", score: 0.68, note: "Non-persistent facial flicker." },
    ],
  },
];

export const blockControls = {
  autoBlockEnabled: true,
  globalProtection: true,
  suspiciousPolicy: "Review before allow",
  strictMode: false,
};

export const moderationRules = [
  {
    id: "rule-01",
    title: "High confidence deepfake",
    description: "Auto-block media when fake confidence is 90% or above.",
    action: "Block",
    scope: "Global",
    status: "Active",
  },
  {
    id: "rule-02",
    title: "Inconclusive public figure content",
    description: "Route to analyst review for sensitive identities or political content.",
    action: "Review",
    scope: "Analyst Queue",
    status: "Active",
  },
  {
    id: "rule-03",
    title: "Trusted publisher allowlist",
    description: "Allow verified sources unless confidence exceeds emergency threshold.",
    action: "Allow",
    scope: "Source Policy",
    status: "Monitored",
  },
];

export const moderationWorkflow = [
  { step: "Detection", detail: "Model flags suspicious media and assigns confidence." },
  { step: "Policy Check", detail: "Rules determine auto-block, allow, or analyst review." },
  { step: "Decision", detail: "System records final moderation decision and audit reason." },
];

export const blocklistEntries = [
  {
    id: "blk-0091",
    thumb: "DF",
    hash: "7f8a3c2d9e1b4a98...",
    source: "Auto-Scan",
    addedAt: "2026-03-14 09:05",
    decision: "Blocked",
    note: "Public re-upload of confirmed synthetic speech video.",
  },
  {
    id: "blk-0090",
    thumb: "RV",
    hash: "4e6b8f1a2c5d44b0...",
    source: "Manual",
    addedAt: "2026-03-14 08:41",
    decision: "Review",
    note: "Queued for analyst due to inconsistent verdict confidence.",
  },
  {
    id: "blk-0088",
    thumb: "AL",
    hash: "9c2f5e8b1a4d77ac...",
    source: "Policy Allow",
    addedAt: "2026-03-13 18:14",
    decision: "Allowed",
    note: "Trusted source media with low synthetic indicators.",
  },
];

export const systemSettings = {
  analystReview: true,
  notifications: true,
  strictMode: false,
  autoSync: true,
  retention: "90 days",
  threshold: 85,
};

export const settingsCards = [
  {
    title: "Analyst Review",
    description: "Require manual review for inconclusive or sensitive content before final enforcement.",
  },
  {
    title: "Notifications",
    description: "Show alerts for new detections, policy changes, and sync failures.",
  },
  {
    title: "Strict Mode",
    description: "Apply higher sensitivity for media from untrusted sources or risky categories.",
  },
];
