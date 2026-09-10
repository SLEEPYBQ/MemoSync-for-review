import { WS_UNAUTHORIZED_EVENT } from "../app/socket"


export function notifyIfUnauthorized(response: Response): Response {
  if (response.status === 401) {
    window.dispatchEvent(new Event(WS_UNAUTHORIZED_EVENT))
  }
  return response
}
