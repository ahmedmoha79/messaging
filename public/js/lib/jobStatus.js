// The life of a job, shared by the app and the public tracking page.

export const STATUS = {
  assigned: { label: 'Assigned', public: 'Booked', tone: 'quiet' },
  loading: { label: 'Loading', public: 'Being loaded', tone: 'active' },
  in_transit: { label: 'In transit', public: 'On the way', tone: 'active' },
  at_border: { label: 'At border', public: 'At the border', tone: 'alert' },
  arrived: { label: 'Arrived', public: 'Arrived', tone: 'active' },
  delivered: { label: 'Delivered', public: 'Delivered', tone: 'done' },
  paid: { label: 'Paid', public: 'Completed', tone: 'done' },
  cancelled: { label: 'Cancelled', public: 'Cancelled', tone: 'muted' }
};

// The steps drawn on the track. "At border" is a moment inside "In transit".
export const STEPS = ['assigned', 'loading', 'in_transit', 'arrived', 'delivered', 'paid'];
export const ACTIVE = ['assigned', 'loading', 'in_transit', 'at_border', 'arrived'];
export const DONE = ['delivered', 'paid'];

export function stepIndex(status) {
  if (status === 'at_border') return STEPS.indexOf('in_transit');
  return STEPS.indexOf(status);
}

export const statusLabel = (s, publicView = false) => (publicView ? STATUS[s]?.public : STATUS[s]?.label) || s;

/** The one obvious next thing a driver does from each status. */
export const NEXT = {
  assigned: { to: 'loading', label: 'Start loading' },
  loading: { to: 'in_transit', label: 'Leave for delivery' },
  in_transit: { to: 'arrived', label: 'Arrived at drop-off' },
  at_border: { to: 'in_transit', label: 'Crossed the border' },
  arrived: { to: 'proof', label: 'Capture proof of delivery' },
  delivered: { to: 'paid', label: 'Mark as paid', staffOnly: true }
};
