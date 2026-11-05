export default async function handle(req, ctx) {
  // Resolve calendarId if it is 'primary'
  let calendarId = req.pathParams.calendarId;
  if (calendarId === 'primary') {
    const owner = await ctx.owner();
    calendarId = owner.id;
  }

  // Ensure events collection has events for this calendar
  // Filter by calendarId (assume 'calendarId' is a field on Event)
  // If no direct calendarId field on Event in the schema, assume filtering by organizer email or some other association? 
  // The Event schema does not show calendarId, so we assume calendarId corresponds to organizer.email or some association.
  // Without association hint, let's assume events have a field calendarId in the world for this collection.
  // We'll filter all events where event.calendarId === calendarId.
  const allEvents = await ctx.ensure('Event', { where: { calendarId }, hint: `events for calendar ${calendarId}` });

  // Filter events by query params:
  // timeMin: lower bound exclusive for event's end time
  // timeMax: upper bound exclusive for event's start time
  // q: free text search summary, description, location, attendees
  // orderBy: 'startTime' or 'updated'
  // maxResults, pageToken handled by ctx.page

  // Parse time bounds if given
  const timeMin = req.query.timeMin ? new Date(req.query.timeMin) : null;
  const timeMax = req.query.timeMax ? new Date(req.query.timeMax) : null;
  const q = req.query.q ? req.query.q.toLowerCase() : null;
  const orderBy = req.query.orderBy || 'startTime';

  // Filter by time and q
  const filtered = allEvents.filter(evt => {
    // Check calendar association: we already filtered by calendarId via ensure but if not, filter here
    if (evt.calendarId !== calendarId) return false;

    const eventEnd = new Date(evt.end.dateTime);
    const eventStart = new Date(evt.start.dateTime);

    if (timeMin && !(eventEnd > timeMin)) {
      // event's end is NOT after timeMin => exclude
      return false;
    }
    if (timeMax && !(eventStart < timeMax)) {
      // event's start is NOT before timeMax => exclude
      return false;
    }

    if (q) {
      // search summary, description, location, attendees email and displayName
      const qFoundInSummary = evt.summary.toLowerCase().includes(q);
      const qFoundInDescription = evt.description && evt.description.toLowerCase().includes(q);
      const qFoundInLocation = evt.location && evt.location.toLowerCase().includes(q);

      let qFoundInAttendees = false;
      if (evt.attendees) {
        for (const a of evt.attendees) {
          if (
            a.email.toLowerCase().includes(q) ||
            (a.displayName && a.displayName.toLowerCase().includes(q))
          ) {
            qFoundInAttendees = true;
            break;
          }
        }
      }
      if (!(qFoundInSummary || qFoundInDescription || qFoundInLocation || qFoundInAttendees)) {
        return false;
      }
    }

    return true;
  });

  // Sort filtered events by orderBy param
  filtered.sort((a, b) => {
    if (orderBy === 'updated') {
      // Descending order by updated time (newest first)
      return new Date(b.updated).getTime() - new Date(a.updated).getTime();
    }
    // default startTime ascending
    return new Date(a.start.dateTime).getTime() - new Date(b.start.dateTime).getTime();
  });

  // Pagination
  const pageResult = ctx.page(filtered, {
    token: req.query.pageToken,
    size: req.query.maxResults,
    defaultSize: 20,
  });

  // Determine timeZone for the calendar
  // We do not have a Calendar type or collection given.
  // Fallback: use the timeZone of the earliest event's start if any, else default 'UTC'
  let timeZone = 'UTC';
  if (pageResult.items.length > 0) {
    const firstEventWithTZ = pageResult.items.find(evt => evt.start.timeZone);
    if (firstEventWithTZ) timeZone = firstEventWithTZ.start.timeZone;
  }

  return {
    items: pageResult.items,
    nextPageToken: pageResult.nextToken || undefined,
    timeZone,
  };
}