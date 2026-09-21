package com.orbitalempire.game;

/**
 * The battle card: what is burning right now, and what is on its way.
 *
 * A SEPARATE PROVIDER, not a mode of the first one, because the widget
 * picker lists providers -- this is how a player gets to choose it --
 * and because someone may want one, the other, or both on their home
 * screen at once.
 *
 * It shares the device pairing and the token with the main card; only
 * the image URL and the "has this ever painted" flag differ. See
 * WidgetWork.Kind. That means adding this widget needed no second
 * pairing flow, and a player who already had the main card connected
 * gets this one filled in without doing anything.
 */
public class OrbitalBattleWidget extends OrbitalWidgetBase {

  @Override
  WidgetWork.Kind kind() {
    return WidgetWork.BATTLE;
  }
}
