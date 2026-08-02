import { supabase } from '../Supabase/client';

/**
 * Formats phone number by removing any non-numeric characters
 * and ensuring it doesn't have a + prefix
 * Used for profiles.whatsapp_number storage
 */
export function formatPhoneNumber(phone: string): string {
  // Remove all non-numeric characters
  return phone.replace(/\D/g, '');
}

/**
 * Formats phone number to E.164 format (with + prefix)
 * Used for auth.users.phone storage
 */
export function formatPhoneE164(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  return `+${cleaned}`;
}

/**
 * Sends WhatsApp OTP to the provided phone number
 */
export async function sendWhatsAppOTP(phone: string): Promise<{ success: boolean; error?: string }> {
  try {
    const formattedPhone = formatPhoneNumber(phone);
    
    const { data, error } = await supabase.functions.invoke('send_whatsapp_otp', {
      body: { phone: formattedPhone },
    });

    if (error) {
      console.error('Error sending WhatsApp OTP:', error);
      return { success: false, error: error.message || 'Failed to send OTP' };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    console.error('Error sending WhatsApp OTP:', error);
    const message = error instanceof Error ? error.message : 'Failed to send OTP';
    return { success: false, error: message };
  }
}

/**
 * Verifies WhatsApp OTP and creates user account
 * @param phone - Phone number without + (for profiles.whatsapp_number)
 * @param phoneE164 - Phone number with + in E.164 format (for auth.users.phone)
 */
export async function verifyWhatsAppOTPAndCreateUser(params: {
  phone: string;
  phoneE164: string;
  otp: string;
  email: string;
  password: string;
  full_name: string;
  profession?: string;
  hospital?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const formattedPhone = formatPhoneNumber(params.phone);

    const { data, error } = await supabase.functions.invoke('verify_whatsapp_otp', {
      body: {
        phone: formattedPhone, // For OTP verification and profiles table (no +)
        phone_e164: params.phoneE164, // For auth.users.phone (with +)
        otp: params.otp,
        email: params.email,
        password: params.password,
        full_name: params.full_name,
        profession: params.profession,
        hospital: params.hospital,
      },
    });

    if (error) {
      console.error('Error verifying WhatsApp OTP:', error);
      return { success: false, error: error.message || 'Failed to verify OTP' };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    return { success: true };
  } catch (error) {
    console.error('Error verifying WhatsApp OTP:', error);
    const message = error instanceof Error ? error.message : 'Failed to verify OTP';
    return { success: false, error: message };
  }
}
