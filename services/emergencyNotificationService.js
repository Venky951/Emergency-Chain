const EmergencyContact = require("../models/emergencycontact");
const EmergencyNotification = require("../models/emergencynotification");

const createEmergencyContactNotifications = async ({
  emergency,
  ownerId,
  session,
}) => {
  const contacts = await EmergencyContact.find({
    owner: ownerId,
    isActive: true,
  })
    .select("_id")
    .session(session)
    .lean();

  if (!contacts.length) return;

  const operations = contacts.map((contact) => {
    const idempotencyKey = `${emergency._id}:EMERGENCY_CONTACT:${contact._id}:EMERGENCY_CREATED:SMS`;

    return {
      updateOne: {
        filter: { idempotencyKey },
        update: {
          $setOnInsert: {
            emergency: emergency._id,
            recipientType: "EMERGENCY_CONTACT",
            recipientContact: contact._id,
            event: "EMERGENCY_CREATED",
            channel: "SMS",
            deliveryStatus: "UNAVAILABLE",
            retryCount: 0,
            idempotencyKey,
          },
        },
        upsert: true,
      },
    };
  });

  await EmergencyNotification.bulkWrite(operations, { session });
};

module.exports = { createEmergencyContactNotifications };
