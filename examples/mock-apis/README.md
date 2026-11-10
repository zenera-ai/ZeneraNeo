# Mock APIs

Inputs for [`zen gym`](../../packages/gym/README.md): API documents, the story of a
world, and the reference documents it draws on.

| Path                                                       | What it is                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [specs/mail.yaml](specs/mail.yaml)                         | A mailbox API shaped after Gmail                                                  |
| [specs/calendar.yaml](specs/calendar.yaml)                 | A calendar API shaped after Google Calendar                                       |
| [stories/northwind-launch.md](stories/northwind-launch.md) | Northwind Labs in the week of a product launch: people, mail, meetings, a bug     |
| [kb/](kb)                                                  | Northwind's handbook: meeting rooms and lengths, the release process, escalations |

Mail and calendar, in two processes sharing one world:

```sh
zen gym serve specs/mail.yaml     --story stories/northwind-launch.md --docs kb --port 8787
zen gym serve specs/calendar.yaml --story stories/northwind-launch.md --docs kb --port 8788
```
