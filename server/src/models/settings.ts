import { Schema, model } from 'mongoose';
import { AUTONOMY_MODES, type AutonomyMode } from '@fia/shared';

export interface SettingsDoc {
  _id: 'global';
  autonomyMode: AutonomyMode;
}

export const SettingsModel = model<SettingsDoc>(
  'Settings',
  new Schema<SettingsDoc>(
    {
      _id: { type: String, required: true },
      autonomyMode: { type: String, enum: AUTONOMY_MODES, required: true },
    },
    { collection: 'settings', versionKey: false },
  ),
);
