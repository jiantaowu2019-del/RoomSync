def equal_allocations(total_minor, payer_id, participant_ids, remainder_policy):
    ordered_ids = [payer_id, *sorted(member_id for member_id in participant_ids if member_id != payer_id)]
    base, remainder = divmod(total_minor, len(ordered_ids))
    if remainder_policy == "PAYER":
        return {member_id: base + (remainder if member_id == payer_id else 0) for member_id in ordered_ids}
    return {member_id: base + (index < remainder) for index, member_id in enumerate(ordered_ids)}
