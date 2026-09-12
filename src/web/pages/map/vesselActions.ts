/**
 * The two buttons at the foot of a ship's or an aircraft's popup: zoom to
 * it, and follow it. Shared by both live layers so the pair reads and
 * behaves identically whichever kind of thing was tapped -- and so the
 * cluster detail view, which reuses `buildShipPopup` wholesale, gets them
 * for free.
 *
 * Deliberately dumb: it renders what it is told and calls back. Whether
 * this vessel is the one being followed is passed in rather than read
 * from `follow.ts` here, because the popup DOM is rebuilt from scratch by
 * the layer (on every poll, and whenever the follow changes) -- so the
 * state belongs to whoever rebuilds it, and a button that subscribed to a
 * signal of its own would be one live subscription per popup ever opened.
 */
import { t } from '../../i18n/index.js';

export interface VesselActions {
    /** Centre the map on this vessel and stay at that zoom. */
    onZoomTo: () => void;
    /** Start following it, or stop if it is already the one being followed. */
    onToggleFollow: () => void;
    /** Whether this vessel is the one currently being followed, which is the only difference between the two labels the follow button can carry. */
    following: boolean;
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vessel-action';
    button.textContent = label;
    button.addEventListener('click', (event) => {
        // The popup sits over the map, and a click that reached the map
        // underneath would fire `MapPage.ts`'s own tap-to-forecast handler
        // as well -- the same guard the cluster list's rows already use.
        event.stopPropagation();
        onClick();
    });
    return button;
}

export function buildVesselActions(actions: VesselActions): HTMLElement {
    const row = document.createElement('div');
    row.className = 'vessel-actions';

    row.append(actionButton(t('map.zoomToVessel'), actions.onZoomTo));

    const follow = actionButton(actions.following ? t('map.stopFollowingVessel') : t('map.followVessel'), actions.onToggleFollow);
    if (actions.following) follow.classList.add('vessel-action--active');
    row.append(follow);

    return row;
}
