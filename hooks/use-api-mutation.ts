import { useMutation } from "convex/react";
import { useState } from "react";

export const useApiMutation = (mutationFunction:any) => {
    const [pending, setPending] = useState(false);
    const mutation = useMutation(mutationFunction);

    const mutate = (payload :any) => {
        setPending(true);
        return mutation(payload)
            .finally(() => setPending(false))
            .then((result) => {
                return result;
            })
            .catch((error) => {
                console.error("Error in api mutation:", error);
                throw error;
            });

    };
    return {
        mutate,
        pending,
    };
}