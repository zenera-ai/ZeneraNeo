export default async function handle(req, ctx) {
  // Extract calendarId from path parameters
  const calendarId = req.pathParams.calendarId;

  // The request body is the event input
  const eventInput = req.body;

  // Generate a new unique event id with strict pattern for id field: lowercase a-v and digits, length >=5
  // Use ctx.newId with a pattern for safe generation, ignoring calendarId to keep the pattern simple
  const eventId = ctx.newId("^[a-v0-9]{5,1024}$");

  // Owner making the request to assign as organizer
  const owner = await ctx.owner();

  // Current timestamp for created and updated
  const now = ctx.now();

  // Compose the new event record from input and server-side fields
  const newEvent = {
    id: eventId,
    status: "confirmed",
    summary: eventInput.summary,
    description: eventInput.description,
    location: eventInput.location,
    start: eventInput.start,
    end: eventInput.end,
    organizer: {
      email: owner.email,
      displayName: owner.displayName,
    },
    attendees: eventInput.attendees,
    recurrence: undefined, // Not supported in input, omit or undefined
    created: now,
    updated: now,
  };

  // Store the event in the collection "events"
  await ctx.db.collection("Event").put(eventId, newEvent);

  // Return the created event
  return newEvent;
}